import React from 'react';

export function Provider({ children }) {
  return <section data-testid="provider" data-system="foundation">{children}</section>;
}

export function Button({ onClick, children, type = 'button', ...props }) {
  return <button {...props} type={type} onClick={onClick}>{children}</button>;
}

export function LinkButton({ onClick, children, href, ...props }) {
  return <a {...props} href={href} onClick={onClick}>{children}</a>;
}

export function ToggleButton({ pressed, onPressedChange, children, type = 'button', ...props }) {
  return (
    <button
      {...props}
      type={type}
      aria-pressed={Boolean(pressed)}
      onClick={() => onPressedChange?.(!pressed)}
    >
      {children}
    </button>
  );
}
