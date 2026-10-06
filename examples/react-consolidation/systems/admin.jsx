import React from 'react';

export function Button({ variant = 'action', selected, onChange, onAction, children, ...props }) {
  if (variant === 'link') {
    return <a {...props} onClick={onAction}>{children}</a>;
  }
  if (variant === 'toggle') {
    return (
      <button
        {...props}
        type="button"
        aria-pressed={Boolean(selected)}
        onClick={() => onChange?.(!selected)}
      >
        {children}
      </button>
    );
  }
  return <button {...props} type="button" onClick={onAction}>{children}</button>;
}
