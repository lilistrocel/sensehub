import React from 'react';

/** The uppercase 11px/14px label: 700 weight, .12em tracking, muted. */
export default function Label({ as: Tag = 'span', className = '', children, ...rest }) {
  return (
    <Tag className={`block text-label uppercase text-muted font-sans ${className}`.trim()} {...rest}>
      {children}
    </Tag>
  );
}
