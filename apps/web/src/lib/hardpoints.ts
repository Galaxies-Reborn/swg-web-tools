import * as THREE from 'three';

/**
 * A hardpoint's transform in the frame that CONTAINS its model.
 *
 * Composed from local matrices walking up the parent chain rather than read off
 * matrixWorld, for two reasons. It is correct on the first render, before three
 * has updated any world matrix -- and it deliberately excludes whatever the
 * model's own group is doing, which is the point: a part mounted on a wing is
 * drawn inside that wing's group, so it must be positioned in the wing's frame
 * and then inherit the roll, rather than have the roll baked into its position
 * and applied a second time.
 *
 * The walk includes the root's own transform and stops there, because the
 * caller renders as a sibling of the root and that is the frame it lands in.
 */
export function transformWithinModel(
  node: THREE.Object3D,
  root: THREE.Object3D,
): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  let current: THREE.Object3D | null = node;
  while (current) {
    current.updateMatrix();
    matrix.premultiply(current.matrix);
    if (current === root) break;
    current = current.parent;
  }
  return matrix;
}
