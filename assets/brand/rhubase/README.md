# RhuBase vector logo

The preferred direction is now the [gap variations](gap-variants/README.md), supplied later on 2026-10-06. `rhubase-logo.svg` remains the earlier solid-junction reference.

User-supplied on 2026-10-06 from `rhubase_01a111e9-ee92-703b-b6fe-3a610a291ee1.svg`. The file is copied byte-for-byte, including its creator attribution. The earlier generated PNG explorations remain in `../rhubase-v1/`.

## Integration notes

- Self-contained SVG geometry; no embedded raster images, scripts, external resources, or font dependencies.
- The lettering is outlined, so provide an accessible name in the consuming page, for example `<img src="/brand/rhubase-logo.svg" alt="RhuBase" />`.
- The supplied canvas is `80 × 80`, with `viewBox="0 0 80 80"`. The horizontal lockup occupies the central band, leaving substantial space above and below. Create a separate tightly framed derivative when integrating it into a compact header; retain this supplied master.
- This is the complete lockup. A favicon should use a separate symbol-only derivative.
- Supplied fills: lime `#84BC26`, crimson `#C02143`, wordmark dark `#131816`, and tagline dark `#161817`.

Validation: parsed as XML, checked element and resource references, and verified that the saved copy matches the supplied file's SHA-256. This was a structural check, not a new visual rendering or trademark clearance.
