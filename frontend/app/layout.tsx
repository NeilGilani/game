import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Synapse-Mesh / Neural Fusion Dashboard', description: 'Inspect real, device-resident LoRA weight fusion and compare model outputs.' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><noscript>This demo needs JavaScript enabled to connect to the local kernel.</noscript>{children}</body></html>;
}
