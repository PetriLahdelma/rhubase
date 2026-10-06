import React from 'react';

export function Provider({ children }) {
  return <section data-testid="provider" data-system="commerce">{children}</section>;
}

export function Button({ onAction, children, type = 'submit', ...props }) {
  return <button {...props} type={type} onClick={onAction}>{children}</button>;
}
