import type { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  action
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between mb-8">
      <div>
        <h1 className="em-h-page">{title}</h1>
        {subtitle && <p className="text-base text-ink-secondary mt-2">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}