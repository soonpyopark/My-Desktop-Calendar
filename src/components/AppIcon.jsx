import { cn } from '../lib/cn.js';

export default function AppIcon({ size = 40, className }) {
  return (
    <img
      src="/icon.png"
      alt=""
      width={size}
      height={size}
      draggable={false}
      className={cn('shrink-0 object-contain', className)}
    />
  );
}
