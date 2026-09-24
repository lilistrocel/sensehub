import React from 'react';

/** Title in Archivo with an optional right-hand slot (actions, pills). */
export default function SectionHeader({
  title,
  subtitle,
  right,
  as: Tag = 'h2',
  className = '',
  children,
  ...rest
}) {
  return (
    <div className={`flex items-start justify-between gap-3 mb-3 ${className}`.trim()} {...rest}>
      <div className="min-w-0">
        <Tag className="font-display text-base font-semibold leading-6 text-ink truncate">{title ?? children}</Tag>
        {subtitle && <p className="text-sm text-muted mt-0.5">{subtitle}</p>}
      </div>
      {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
    </div>
  );
}
