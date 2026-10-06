// Chosen target for this controlled fixture, not a real published library.
export function Button({ label, type = 'button', disabled = false }) {
  return { role: 'button', type, label, disabled, loading: false, announcesLoading: false };
}
export function LinkButton({ label, href }) {
  return { role: 'link', label, href, newTabAllowed: true };
}
export function ToggleButton({ label, pressed }) {
  return { role: 'button', type: 'button', label, pressed };
}
export const theme = { spacing: 8, ring: 'foundation' };
