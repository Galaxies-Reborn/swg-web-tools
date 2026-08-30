import type { Metadata } from 'next';

import { Shell } from '@/components/shell';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'PRE-CU Reborn',
    template: '%s · PRE-CU Reborn',
  },
  description:
    'Live bazaar, resource, and character dashboards for the PRE-CU Reborn galaxy — a Publish 14.1 Star Wars Galaxies restoration.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
