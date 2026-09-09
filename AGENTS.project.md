# Project Directives

## Asset preservation — primary directive

Never delete, overwrite, replace, or remove an existing game asset when creating a new asset or visual variant. Preserve every prior asset and add new variants as separate files. Every new visual-effect variant must use an explicit, monotonically increasing serial (for example, `arrow-001`, `arrow-002`); never reuse or replace an earlier serial. A serial preserves the complete effect recipe: the asset, render code, particles, blend mode, scale, travel speed, rotation, trail, and impact behavior. Never preserve only the image while silently changing the effect around it. Reordering, selecting a default, or hiding an asset in the UI is allowed only when explicitly requested; the underlying prior file must remain intact.