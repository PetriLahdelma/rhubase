// Controlled model of a second source system with overloaded semantics.
export function Button({ label, variant = 'action', href, selected = false }) {
  if (variant === 'contentLink') return { role: 'link', label, href, newTabAllowed: true };
  if (variant === 'toggle') return { role: 'button', type: 'button', label, pressed: selected };
  return { role: 'button', type: 'button', label };
}
export const theme = { spacing: 8, ring: 'legacy' };
