// Controlled model of one source system. No React/DOM claim.
export function Button({ label, type = 'submit', disabled = false, loading = false }) {
  return { role: 'button', type, label, disabled, loading, announcesLoading: false };
}
export const theme = { spacing: 8, ring: 'legacy' };
