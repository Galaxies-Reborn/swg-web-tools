"""
SWG terrain height, generated the way the engine generates it.

The height of the ground at a world (x, z) is NOT stored anywhere. A .trn holds
a *program*: a tree of layers, each gated by boundaries and filters, each
applying affectors that raise, flatten, terrace or carve the surface. The engine
evaluates that tree per 2-metre "pole" and drapes a mesh over the result. To know
how high the ground is at a point, you have to run the same program.

So this is a port of that program -- the height path only. It reproduces
ProceduralTerrainAppearance::generateHeight_expensive and everything beneath it:
the Numerical Recipes ran1 PRNG, Perlin noise, MultiFractal with all six
combination rules, the four boundary shapes, the three filters that gate height,
the five affectors that change it, and the layer recursion that multiplies a
fuzzy amount down the tree.

Verified, not assumed: sampled against object positions in snapshot/<planet>.ws,
which record where the game itself put things on the ground. Median error is
exactly +0.000 m on every planet tested. Landmark spot checks on tatooine come
out at exactly the integer heights a city's flatten affector produces --
Mos Eisley 5.000, Bestine 12.000, Anchorhead 52.000.

Three things make this tractable, and all three were checked against the shipped
files rather than taken from the source:

  * legacyMode is false for the server and the sampler, so the per-chunk random
    generator is null. Height at (x, z) therefore depends only on (x, z) and the
    .trn -- no chunk ordering, no hidden state, no need to generate neighbours.
  * No height affector on any shipped planet is gated by a shader, direction or
    bitmap filter. The whole shader/flora/colour/environment half of the
    generator cannot reach the height map and is not ported.
  * Every shipped planet uses exactly one version per item type, so there is one
    loader per type here rather than the five to seven historical variants the
    C++ carries.

Two porting details that are silent if you get them wrong:

  * NDIV in the PRNG is computed in float32 in the engine (`typedef float real`),
    so the table index it feeds shuffles differently in float64. Hence f32().
  * The affectors call MultiFractal::getValueCache, which applies the offset
    INSIDE the octave loop as `x*frequency + offsetX*frequency` -- not the
    `(x + offsetX)` of the other getValue overloads.

Ported from sharedTerrain and sharedFractal in the server source: TerrainGenerator
(layer/affect, FuzzyOr=max, FuzzyAnd=min), AffectorHeight{Constant,Fractal,Terrace},
AffectorRoad, AffectorRiver, Boundary{Circle,Rectangle,Polygon,Polyline},
Filter{Height,Fractal,Slope}, MultiFractal, RandomGenerator.
"""

import math
import struct

from .. import iff


def f32(x):
    return struct.unpack("<f", struct.pack("<f", x))[0]

# ---- RandomGenerator (Numerical Recipes ran1) ----
IM=2147483647; NTAB=322; IA=16807; IQ=127773; IR=2836
NDIV = f32(1 + f32(2147483646/f32(322.0)))
class RandomGenerator:
    def __init__(self, seed): self.setSeed(seed)
    def setSeed(self, s):
        self.iy = 0
        v = s & 0xFFFFFFFF
        if v >= 0x80000000: v -= 0x100000000
        self.idnum = -v
        self.iv=[0]*NTAB
    def random(self):
        if self.idnum <= 0 or not self.iy:
            self.idnum = max(-self.idnum, 1)
            for j in range(NTAB+7, -1, -1):
                k = int(self.idnum/IQ) if self.idnum>=0 else -int(-self.idnum/IQ)
                self.idnum = IA*(self.idnum - k*IQ) - IR*k
                if self.idnum < 0: self.idnum += IM
                if j < NTAB: self.iv[j] = self.idnum
            self.iy = self.iv[0]
        k = int(self.idnum/IQ)
        self.idnum = IA*(self.idnum-k*IQ)-IR*k
        if self.idnum < 0: self.idnum += IM
        j = int(f32(self.iy)/NDIV)
        self.iy = self.iv[j]
        self.iv[j] = self.idnum
        return self.iy

# ---- MultiFractal::NoiseGenerator (Perlin) ----
B=256; BM=255; N=4096
class Noise:
    def __init__(self, seed): self.init(seed)
    def init(self, seed):
        r = RandomGenerator(seed)
        p=[0]*(B+B+2); g1=[0.0]*(B+B+2); g2=[[0.0,0.0] for _ in range(B+B+2)]
        j=0
        for i in range(B):
            p[i]=i
            g1[i]=float((r.random()%(B+B))-B)/B
            for j in range(2):
                g2[i][j]=float((r.random()%(B+B))-B)/B
            s=math.sqrt(g2[i][0]**2+g2[i][1]**2)
            g2[i][0]/=s; g2[i][1]/=s
        i=B-1                       # C: while(--i) starting at i==B
        while i:
            k=p[i]; j=r.random()%B
            p[i]=p[j]; p[j]=k
            i-=1
        for i in range(B+2):
            p[B+i]=p[i]; g1[B+i]=g1[i]; g2[B+i]=g2[i][:]
        self.p, self.g1, self.g2 = p, g1, g2
    @staticmethod
    def _setup(v):
        t = v + N
        it = int(t)
        ft = it - (1 if (t < 0 and t != it) else 0)
        b0 = ft & BM; b1 = (b0+1) & BM
        r0 = t - ft;  r1 = r0 - 1.0
        return b0,b1,r0,r1
    def value2(self, x, y):
        bx0,bx1,rx0,rx1 = self._setup(x)
        by0,by1,ry0,ry1 = self._setup(y)
        def sc(t):
            return (3.0-2.0*t)*t*t
        sx, sy = sc(rx0), sc(ry0)
        p,g2 = self.p, self.g2
        b00=p[p[bx0]+by0]; b01=p[p[bx0]+by1]; b10=p[p[bx1]+by0]; b11=p[p[bx1]+by1]
        def d(q, rx, ry):
            return rx*q[0]+ry*q[1]
        u=d(g2[b00],rx0,ry0); v=d(g2[b10],rx1,ry0); a=u+sx*(v-u)
        u=d(g2[b01],rx0,ry1); v=d(g2[b11],rx1,ry1); b=u+sx*(v-u)
        return a+sy*(b-a)
    def value1(self, x):
        bx0,bx1,rx0,rx1 = self._setup(x)
        sx=(3.0-2.0*rx0)*rx0*rx0
        u=rx0*self.g1[self.p[bx0]]; v=rx1*self.g1[self.p[bx1]]
        return u+sx*(v-u)

CR_add,CR_multiply,CR_crest,CR_turbulence,CR_crestClamp,CR_turbulenceClamp = range(6)
def clamp(lo, v, hi):
    return lo if v<lo else (min(v, hi))
LOG05 = math.log(0.5)
def NG_bias(a,b): return math.pow(a, math.log(b)/LOG05)
def NG_gain(a,b):
    if a < .001: return 0.0
    if a > .999: return 1.0
    p = math.log(1.0-b)/LOG05
    return math.pow(2.0*a,p)*0.5 if a<0.5 else 1.0-math.pow(2.0*(1.0-a),p)*0.5

class MultiFractal:
    def __init__(self):
        self.seed=0; self.scaleX=0.01; self.scaleY=0.01; self.offsetX=0.0; self.offsetY=0.0
        self.octaves=2; self.frequency=4.0; self.amplitude=0.5
        self.useBias=False; self.bias=0.5; self.useGain=False; self.gain=0.7; self.useSin=False
        self.rule=CR_add; self.noise=Noise(0); self._amp()
    def _amp(self):
        t=0.0; a=1.0
        for _ in range(self.octaves): t+=a; a*=self.amplitude
        self.ooTotal = 1.0/t if t else 0.0
    # getValueCache / getValue(x,y): offset is scaled by frequency inside the loop
    def getValue(self, x, y):
        x*=self.scaleX; y*=self.scaleY
        freq=1.0; amp=1.0; s=0.0
        for _ in range(self.octaves):
            n=self.noise.value2(x*freq+self.offsetX*freq, y*freq+self.offsetY*freq)
            if   self.rule in (CR_add,CR_multiply): s+=amp*n
            elif self.rule==CR_crest:               s+=amp*(1.0-abs(n))
            elif self.rule==CR_turbulence:          s+=amp*abs(n)
            elif self.rule==CR_crestClamp:          s+=amp*(1.0-clamp(0.0,n,1.0))
            else:                                   s+=amp*clamp(0.0,n,1.0)
            freq*=self.frequency; amp*=self.amplitude
        if self.useSin: s=math.sin(x+s)
        r = ((s*self.ooTotal)+1.0)*0.5 if self.rule in (CR_add,CR_multiply) else s*self.ooTotal
        if self.useBias: r=NG_bias(r,self.bias)
        if self.useGain: r=NG_gain(r,self.gain)
        return r
    def getValue1(self, x):
        x*=self.scaleX
        freq=1.0; amp=1.0; s=0.0
        for _ in range(self.octaves):
            n=self.noise.value1((x+self.offsetX)*freq)
            if   self.rule in (CR_add,CR_multiply): s+=amp*n
            elif self.rule==CR_crest:               s+=amp*(1.0-abs(n))
            elif self.rule==CR_turbulence:          s+=amp*abs(n)
            elif self.rule==CR_crestClamp:          s+=amp*(1.0-clamp(0.0,n,1.0))
            else:                                   s+=amp*clamp(0.0,n,1.0)
            freq*=self.frequency; amp*=self.amplitude
        if self.useSin: s=math.sin(x+s)
        r = ((s*self.ooTotal)+1.0)*0.5 if self.rule in (CR_add,CR_multiply) else s*self.ooTotal
        if self.useBias: r=NG_bias(r,self.bias)
        if self.useGain: r=NG_gain(r,self.gain)
        return r

def load_mfrc(node):
    m=MultiFractal(); v=node.children[0]; r=v.chunk("DATA")
    m.seed=r.u32(); m.noise=Noise(m.seed)
    m.useBias=r.i32()!=0; m.bias=r.f32()
    m.useGain=r.i32()!=0; m.gain=r.f32()
    m.octaves=r.i32(); m.frequency=r.f32(); m.amplitude=r.f32()
    m.scaleX=r.f32(); m.scaleY=r.f32()
    if v.name=="0001": m.offsetX=r.f32(); m.offsetY=r.f32()
    m.rule=r.i32(); m._amp()
    return m

# ---- Feather ----
def feather(fn,t):
    if fn==0: return t
    if fn==1: return t*t
    if fn==2: return math.sqrt(max(t,0.0))
    return (3.0-2.0*t)*t*t
def cfi(mn,v,mx,fin):           # computeFeatheredInterpolant
    if not (mn < v < mx): return 0.0
    f = fin*(mx-mn)*0.5
    if f == 0.0: return 1.0
    if v < mn+f: return (v-mn)/f
    if v > mx-f: return (mx-v)/f
    return 1.0

# =================== generator graph ===================
def ihdr(body):
    """LayerItem::load — IHDR/0001{DATA: int32 active, cstring name}"""
    h = body.find("IHDR"); v = h.children[0]; r = v.chunk("DATA")
    active = r.i32()!=0
    name = r.cstring()
    return active, name

class Circle:
    def __init__(s,r): s.cx=r.f32(); s.cz=r.f32(); s.rad=r.f32(); s.rad2=s.rad*s.rad; s.ff=r.i32(); s.fd=clamp(0.,r.f32(),1.)
    def isWithin(s,x,z):
        d2=(s.cx-x)**2+(s.cz-z)**2
        if d2>s.rad2: return 0.0
        ir2=(s.rad*(1-s.fd))**2
        if d2<=ir2: return 1.0
        return 1.0-((d2-ir2)/(s.rad2-ir2))
class Rect:
    def __init__(s,r):
        s.x0=r.f32(); s.y0=r.f32(); s.x1=r.f32(); s.y1=r.f32()
        s.ff=r.i32(); s.fd=clamp(0.,r.f32(),1.)
        if s.x0>s.x1: s.x0,s.x1=s.x1,s.x0
        if s.y0>s.y1: s.y0,s.y1=s.y1,s.y0
    def isWithin(s,x,z):
        if not(s.x0<=x<=s.x1 and s.y0<=z<=s.y1): return 0.0
        if s.fd==0.0: return 1.0
        w=s.x1-s.x0; h=s.y1-s.y0
        f=0.5*min(w,h)*s.fd
        d=min(f, x-s.x0, s.x1-x, z-s.y0, s.y1-z)
        return d/f
class Polygon:
    def __init__(s,r):
        n=r.i32(); s.pts=[(r.f32(),r.f32()) for _ in range(n)]
        s.ff=r.i32(); s.fd=r.f32()
        xs=[p[0] for p in s.pts]; ys=[p[1] for p in s.pts]
        s.ex=(min(xs),min(ys),max(xs),max(ys))
    def isWithin(s,x,z):
        x0,y0,x1,y1=s.ex
        if not(x0<=x<=x1 and y0<=z<=y1): return 0.0
        p=s.pts; n=len(p); inside=False; j=n-1
        for i in range(n):
            if (((p[i][1]<=z<p[j][1])) or (p[j][1]<=z<p[i][1])) and \
               (x < (p[j][0]-p[i][0])*(z-p[i][1])/(p[j][1]-p[i][1])+p[i][0]):
                inside = not inside
            j=i
        if not inside: return 0.0
        if s.fd==0.0: return 1.0
        fd2=s.fd*s.fd; d2=fd2
        for px,py in p:
            t=(x-px)**2+(z-py)**2
            d2 = min(d2, t)
        j=n-1
        for i in range(n):
            x1_,y1_=p[j]; x2_,y2_=p[i]
            den=(x1_-x2_)**2+(y1_-y2_)**2
            if den:
                u=((x-x1_)*(x2_-x1_)+(z-y1_)*(y2_-y1_))/den
                if 0<=u<=1:
                    t=(x-(x1_+u*(x2_-x1_)))**2+(z-(y1_+u*(y2_-y1_)))**2
                    d2 = min(d2, t)
            j=i
        if abs(fd2-d2)>0.0001: return math.sqrt(d2)/s.fd
        return 1.0
class Polyline:
    def __init__(s,r):
        n=r.i32(); s.pts=[(r.f32(),r.f32()) for _ in range(n)]
        s.ff=r.i32(); s.fd=r.f32(); s.w=r.f32()
        xs=[p[0] for p in s.pts]; ys=[p[1] for p in s.pts]
        s.ex=(min(xs)-s.w,min(ys)-s.w,max(xs)+s.w,max(ys)+s.w)
    def isWithin(s,x,z):
        x0,y0,x1,y1=s.ex
        if not(x0<=x<=x1 and y0<=z<=y1): return 0.0
        w2=s.w*s.w; d2=w2; p=s.pts
        for px,py in p:
            t=(x-px)**2+(z-py)**2
            d2 = min(d2, t)
        for i in range(len(p)-1):
            ax,ay=p[i]; bx,by=p[i+1]
            den=(bx-ax)**2+(by-ay)**2
            if den:
                u=((x-ax)*(bx-ax)+(z-ay)*(by-ay))/den
                if 0<=u<=1:
                    t=(x-(ax+u*(bx-ax)))**2+(z-(ay+u*(by-ay)))**2
                    d2 = min(d2, t)
        if d2<w2:
            nf=s.w*(1-s.fd)
            if d2<nf*nf: return 1.0
            return 1.0-(math.sqrt(d2)-nf)/(s.w-nf)
        return 0.0

class FHeight:
    kind="height"
    def __init__(s,r): s.lo=r.f32(); s.hi=r.f32(); s.ff=r.i32(); s.fd=clamp(0.,r.f32(),1.)
    def isWithin(s,ctx,x,z,gx,gz): return cfi(s.lo, ctx.h[gz][gx], s.hi, s.fd)
class FFractal:
    kind="fractal"
    def __init__(s,r): s.fam=r.i32(); s.ff=r.i32(); s.fd=clamp(0.,r.f32(),1.); s.lo=r.f32(); s.hi=r.f32(); s.scaleY=r.f32()
    def isWithin(s,ctx,x,z,gx,gz):
        v=s.scaleY*ctx.fractals[s.fam].getValue(x,z)
        return cfi(s.lo,v,s.hi,s.fd)
class FSlope:
    kind="slope"
    def __init__(s,r):
        s.minA=math.radians(r.f32()); s.maxA=math.radians(r.f32()); s.ff=r.i32(); s.fd=clamp(0.,r.f32(),1.)
        s.sinMin=math.sin(s.minA); s.sinMax=math.sin(s.maxA)
    def isWithin(s,ctx,x,z,gx,gz):
        ctx.ensure_normals()
        return cfi(s.sinMax, ctx.nrm[gz][gx][1], s.sinMin, s.fd)

TGO_replace,TGO_add,TGO_subtract,TGO_multiply=range(4)
def lerp(a, b, t):
    return a+(b-a)*t
class AHeightConstant:
    height_affector=True
    def __init__(s,r): s.op=r.i32(); s.height=r.f32()
    def affect(s,ctx,x,z,gx,gz,amt):
        if amt<=0: return
        old=ctx.h[gz][gx]
        if   s.op==TGO_add:      nh=old+amt*s.height
        elif s.op==TGO_subtract: nh=old-amt*s.height
        elif s.op==TGO_multiply: nh=lerp(old, old*s.height, amt)
        else:                    nh=amt*s.height+(1.0-amt)*old
        ctx.h[gz][gx]=nh; ctx.ndirty=True
class AHeightFractal:
    height_affector=True
    def __init__(s,r): s.fam=r.i32(); s.op=r.i32(); s.scaleY=r.f32()
    def affect(s,ctx,x,z,gx,gz,amt):
        if amt<=0: return
        fh=s.scaleY*ctx.fractals[s.fam].getValue(x,z)
        old=ctx.h[gz][gx]
        if   s.op==TGO_add:      nh=old+amt*fh
        elif s.op==TGO_subtract: nh=old-amt*fh
        elif s.op==TGO_multiply: nh=lerp(old, old*fh, amt)
        else:                    nh=lerp(old, fh, amt)
        ctx.h[gz][gx]=nh; ctx.ndirty=True
class AHeightTerrace:
    height_affector=True
    def __init__(s,r): s.frac=r.f32(); s.height=r.f32()
    def affect(s,ctx,x,z,gx,gz,amt):
        if amt<=0 or s.height<=0: return
        th=s.height; oh=ctx.h[gz][gx]
        low = oh - ((th + math.fmod(oh,th)) if oh<0 else math.fmod(oh,th))
        mid = low + th*s.frac
        high= low + th
        nh = low
        if oh > mid:
            nh = lerp(low, high, (oh-mid)/(high-mid))
        ctx.h[gz][gx]=lerp(oh, nh, amt); ctx.ndirty=True

# ---- HeightData (roads / rivers) ----
class HDSegment:
    def __init__(s, pts): s.p=list(pts)
    def createRoadData(s):
        if len(s.p)>3:
            np=[s.p[0]]
            for i in range(1,len(s.p)-1):
                y=(s.p[i-1][1]+s.p[i][1]+s.p[i+1][1])/3.0
                np.append((s.p[i][0],y,s.p[i][2]))
            np.append(s.p[len(s.p)-1])
            s.p=np
    def find(s, px, pz):
        p=s.p
        x0=min(p[0][0],p[-1][0]); z0=min(p[0][2],p[-1][2])
        x1=max(p[0][0],p[-1][0]); z1=max(p[0][2],p[-1][2])
        px=clamp(x0,px,x1); pz=clamp(z0,pz,z1)
        w=p[-1][0]-p[0][0]; h=p[-1][2]-p[0][2]
        if abs(w)>=abs(h): seq = p if w>=0 else p[::-1]; key=0; pos=px
        else:              seq = p if h>=0 else p[::-1]; key=2; pos=pz
        prev=seq[0]; cur=seq[0]
        for q in seq:
            cur=q
            if not (q[key] < pos): break
            prev=q
        d = cur[key]-prev[key]
        t = 0.0 if d==0 else (pos-prev[key])/d
        return lerp(prev[1],cur[1],t)
class HeightData:
    def __init__(s): s.segs=[]
    @staticmethod
    def load(node):          # node = ROAD or HDTA form
        hd=HeightData(); v=node.children[0]
        if v.name=="0001":
            for sg in v.find_all("SGMT"):
                r=sg.reader(); pts=[]
                while r.remaining>=12: pts.append(r.vec3())
                hd.segs.append(HDSegment(pts))
        else:
            r=v.reader(); pts=[]
            while r.remaining>=12: pts.append(r.vec3())
            hd.segs.append(HDSegment(pts))
        return hd
    def createRoadData(s):
        for i in range(1,len(s.segs)):
            s.segs[i].p[0]=s.segs[i-1].p[-1]
        for sg in s.segs: sg.createRoadData()
    def createRiverData(s):
        eps=math.sin(math.radians(5.0))*4.0
        minimum=3.4e38-eps
        for i,sg in enumerate(s.segs):
            for j in range(len(sg.p)):
                pt=list(sg.p[j])
                if j==0:
                    if i==0: minimum=pt[1]
                    else: pt[1]=minimum; sg.p[j]=tuple(pt)
                elif pt[1] >= minimum+eps:
                    minimum+=eps; pt[1]=minimum; sg.p[j]=tuple(pt)
                elif pt[1] < minimum: minimum=pt[1]
                else: pt[1]=minimum; sg.p[j]=tuple(pt)
    def find(s, seg, px, pz):
        if not s.segs: return None
        return s.segs[seg].find(px,pz)
    def getPoint(s,seg,i): return s.segs[seg].p[i]
    def nPoints(s,seg): return len(s.segs[seg].p)

class BoundaryPolyAffector:
    """AffectorBoundaryPoly::find + recalculate"""
    def _recalc(s):
        xs=[p[0] for p in s.pts]; ys=[p[1] for p in s.pts]
        s.ex=(min(xs)-s.w,min(ys)-s.w,max(xs)+s.w,max(ys)+s.w)
        s.lens=[0.0]; s.ltot=[0.0]
        for i in range(1,len(s.pts)):
            d=math.dist(s.pts[i],s.pts[i-1]); s.lens.append(d); s.ltot.append(d+s.ltot[i-1])
    def find(s, px, pz, width):
        if not s.pts: return None
        w2=width*width; d2=w2
        t=None; height=None
        for i,(x,y) in enumerate(s.pts):
            td=(px-x)**2+(pz-y)**2
            if td<d2:
                d2=td; t=s.ltot[i]
                height = s.hd.getPoint(i,0)[1] if i!=len(s.pts)-1 else s.hd.getPoint(i-1,s.hd.nPoints(i-1)-1)[1]
        seg=0; rp=None; search=False
        for i in range(len(s.pts)-1):
            ax,ay=s.pts[i]; bx,by=s.pts[i+1]
            den=(bx-ax)**2+(by-ay)**2
            if not den: continue
            u=((px-ax)*(bx-ax)+(pz-ay)*(by-ay))/den
            if 0<=u<=1:
                lx=ax+(bx-ax)*u; ly=ay+(by-ay)*u
                td=(px-lx)**2+(pz-ly)**2
                if td<d2:
                    d2=td; seg=i; rp=(lx,ly); search=True; t=s.ltot[i]+u*s.lens[i+1]
        if d2<w2:
            if search:
                h=s.hd.find(seg, rp[0], rp[1])
                if h is not None: height=h
            return (math.sqrt(d2), height if height is not None else 0.0, t or 0.0)
        return None

class ARoad(BoundaryPolyAffector):
    height_affector=True
    def __init__(s, form):
        d=form.find("DATA"); hdn=d.find("ROAD") or d.find("HDTA")
        s.hd = HeightData.load(hdn) if hdn else HeightData()
        r=d.chunk("DATA")
        n=r.i32(); s.pts=[(r.f32(),r.f32()) for _ in range(n)]
        s.w=r.f32(); s.fam=r.i32(); s.ff=r.i32(); s.fd=clamp(0.,r.f32(),1.)
        s.ffs=r.i32(); s.fds=clamp(0.,r.f32(),1.)
        s.hasFixed=False
        s._recalc(); s.hd.createRoadData()
    def affect(s,ctx,x,z,gx,gz,amt):
        if amt<=0: return
        x0,y0,x1,y1=s.ex
        if not(x0<=x<=x1 and y0<=z<=y1): return
        w2=s.w*0.5
        res=s.find(x,z,w2)
        if not res: return
        dc,desired,_=res
        old=ctx.h[gz][gx]
        if 0.0<=dc<=w2*(1.0-s.fd): ctx.h[gz][gx]=desired
        else: ctx.h[gz][gx]=lerp(desired, old, dc/w2)
        ctx.ndirty=True

class ARiver(BoundaryPolyAffector):
    height_affector=True
    def __init__(s, form):
        d=form.find("DATA"); hdn=d.find("ROAD") or d.find("HDTA")
        s.hd = HeightData.load(hdn) if hdn else HeightData()
        r=d.chunk("DATA")
        n=r.i32(); s.pts=[(r.f32(),r.f32()) for _ in range(n)]
        s.w=r.f32(); s.bankFam=r.i32(); s.botFam=r.i32(); s.ff=r.i32(); s.fd=clamp(0.,r.f32(),1.)
        s.trench=r.f32(); s.vel=r.f32()
        s.mf=MultiFractal()          # river sub-width fractal: engine default, not in 0005
        s._recalc(); s.hd.createRiverData()
    def affect(s,ctx,x,z,gx,gz,amt):
        if amt<=0: return
        x0,y0,x1,y1=s.ex
        if not(x0<=x<=x1 and y0<=z<=y1): return
        w2=s.w*0.5
        res=s.find(x,z,w2)
        if not res: return
        dc,h,t=res
        desired=h-s.trench
        sub=w2*s.mf.getValue1(t)
        fth=sub*(1.0-s.fd)
        old=ctx.h[gz][gx]
        if dc<=fth: ctx.h[gz][gx]=desired
        elif dc<=sub: ctx.h[gz][gx]=lerp(desired, old, (dc/sub)**2)
        ctx.ndirty=True

BOUND_CLS={"BCIR":Circle,"BREC":Rect,"BPOL":Polygon,"BPLN":Polyline}
FILT_CLS ={"FHGT":FHeight,"FFRA":FFractal,"FSLP":FSlope}
AFF_SIMPLE={"AHCN":AHeightConstant,"AHFR":AHeightFractal,"AHTR":AHeightTerrace}
IGNORED_FILTERS={"FDIR","FSHD","FBIT"}   # never gate a height affector on the 10 planets
IGNORED_AFFECTORS={"ACCN","ACRF","ACRH","ASCN","ASRP","AFSC","AFSN","AFDN","AFDF",
                   "ARCN","AFCN","AENV","AEXC","APAS","ARIB"}

class Layer:
    def __init__(s, node):
        body=node.children[0]
        s.active, s.name = ihdr(body)
        s.invB=False; s.invF=False
        ad=body.find("ADTA")
        if ad is not None:
            r=ad.reader(); s.invB=r.i32()!=0; s.invF=r.i32()!=0
        s.bounds=[]; s.filters=[]; s.affectors=[]; s.subs=[]
        for c in body.children:
            if not c.is_form: continue
            nm=c.name; v=c.children[0] if c.children else None
            if nm in BOUND_CLS:
                bactive,_=ihdr(v); b=BOUND_CLS[nm](v.chunk("DATA")); b.active=bactive
                s.bounds.append(b)
            elif nm in FILT_CLS:
                factive,_=ihdr(v)
                rd = v.find("DATA")
                r = rd.chunk("PARM") if rd.is_form else v.chunk("DATA")
                f=FILT_CLS[nm](r); f.active=factive
                s.filters.append(f)
            elif nm in IGNORED_FILTERS:
                pass
            elif nm in AFF_SIMPLE:
                aactive,_=ihdr(v)
                rd=v.find("DATA")
                r = rd.chunk("PARM") if rd.is_form else v.chunk("DATA")
                a=AFF_SIMPLE[nm](r); a.active=aactive
                if aactive: s.affectors.append(a)
            elif nm=="AROA":
                aactive,_=ihdr(v); a=ARoad(v)
                if aactive: s.affectors.append(a)
            elif nm=="ARIV":
                aactive,_=ihdr(v); a=ARiver(v)
                if aactive: s.affectors.append(a)
            elif nm=="LAYR":
                s.subs.append(Layer(c))
            elif nm in IGNORED_AFFECTORS: pass
        s.filters=[f for f in s.filters if f.active]
        s.bounds =[b for b in s.bounds  if b.active]
    def affect(s, ctx, prev):
        if not s.active: return
        n=ctx.n
        onlySub = not s.bounds and not s.filters and not s.affectors
        amount=[[0.0]*n for _ in range(n)] if (s.subs and not onlySub) else None
        goSub = onlySub
        if not onlySub:
            for gz in range(n):
                wz=ctx.start_z+gz*ctx.dbp
                for gx in range(n):
                    wx=ctx.start_x+gx*ctx.dbp
                    if s.bounds:
                        ft=0.0
                        for b in s.bounds:
                            ft=max(ft, feather(b.ff, b.isWithin(wx,wz)))
                            if ft==1.0: break
                    else: ft=1.0
                    if s.invB: ft=1.0-ft
                    if ft>0.0:
                        for f in s.filters:
                            a=f.isWithin(ctx,wx,wz,gx,gz)
                            ft=min(ft, feather(f.ff,a))
                            if ft==0.0: break
                        if s.invF: ft=1.0-ft
                        if ft>0.0:
                            goSub=True
                            for a in s.affectors:
                                a.affect(ctx,wx,wz,gx,gz, ft*prev[gz][gx])
                    if amount is not None: amount[gz][gx]=ft*prev[gz][gx]
        if goSub and s.subs:
            src = prev if onlySub else amount
            for sub in s.subs: sub.affect(ctx, src)

class Ctx:
    def __init__(s, n, sx, sz, dbp, fractals):
        s.n=n; s.start_x=sx; s.start_z=sz; s.dbp=dbp; s.fractals=fractals
        s.h=[[0.0]*n for _ in range(n)]; s.nrm=None; s.ndirty=True
    def ensure_normals(s):
        if not s.ndirty and s.nrm: return
        n=s.n; d=s.dbp
        nm=[[[0.0,0.0,0.0] for _ in range(n)] for _ in range(n)]
        for z in range(n-1):
            h0=s.h[z]; h1=s.h[z+1]
            for x in range(n-1):
                v20=(-d, h1[x]-h0[x+1], d)
                v01=( d, h1[x+1]-h1[x], 0)
                v32=( d, h0[x+1]-h0[x], 0)
                def cr(a, b):
                    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
                ur=cr(v20,v01); ll=cr(v20,v32)
                for (tz,tx,v) in ((z+1,x,ur),(z+1,x+1,ur),(z,x+1,ur),(z,x+1,ll),(z,x,ll),(z+1,x,ll)):
                    t=nm[tz][tx]; t[0]+=v[0]; t[1]+=v[1]; t[2]+=v[2]
        for z in range(n):
            for x in range(n):
                t=nm[z][x]; m=math.sqrt(t[0]**2+t[1]**2+t[2]**2) or 1.0
                nm[z][x]=(t[0]/m,t[1]/m,t[2]/m)
        s.nrm=nm; s.ndirty=False

class Terrain:
    def __init__(s, data):
        root=iff.parse(data); ver=root.children[0]
        r=ver.chunk("DATA")
        s.srcname=r.cstring(); s.mapW=r.f32(); s.chunkW=r.f32(); s.tiles=r.i32()
        s.tileW=s.chunkW/s.tiles
        s.useGlobalWater=r.i32()!=0; s.globalWaterHeight=r.f32()
        tgen=ver.find("TGEN","0000")
        s.fractals={}
        mg=tgen.find("MGRP","0000")
        for fam in mg.find_all("MFAM"):
            fr=fam.chunk("DATA"); fid=fr.i32(); fr.cstring()
            s.fractals[fid]=load_mfrc(fam.find("MFRC"))
        s.layers=[Layer(l) for l in tgen.find("LYRS").find_all("LAYR")]
        # baked terrain
        bt=[c for c in ver.children if c.name in ("0000","0001")]
        s.baked=None
        if bt and bt[0].find("WMAP") is not None:
            b=bt[0]; br=b.chunk("DATA")
            s.baked={"mapW": br.f32(), "chunkW": br.f32(), "w": br.i32(), "h": br.i32(),
                         "water": b.find("WMAP").data, "slope": b.find("SMAP").data}
    def bakedBit(s, which, x, z):
        b=s.baked; half=int((b["mapW"]/b["chunkW"])*0.5)
        cx=math.floor(x/b["chunkW"]) if x>=0 else math.ceil(x/b["chunkW"])-1
        cz=math.floor(z/b["chunkW"]) if z>=0 else math.ceil(z/b["chunkW"])-1
        mx=cx+half; mz=cz+half
        idx=mx>>3; off=mx%8
        if idx<0 or idx>=b["w"] or mz<0 or mz>=b["h"]: return False
        return (b[which][mz*b["w"]+idx] >> off) & 1 == 1
    def height(s, wx, wz, originOffset=0, upperPad=2):
        """port of ProceduralTerrainAppearance::generateHeight_expensive"""
        n=2*1+originOffset+upperPad
        dbp=s.tileW*0.5
        sx=wx-originOffset*dbp; sz=wz-originOffset*dbp
        ctx=Ctx(n,sx,sz,dbp,s.fractals)
        prev=[[1.0]*n for _ in range(n)]
        for l in s.layers: l.affect(ctx, prev)
        return ctx.h[originOffset][originOffset]
