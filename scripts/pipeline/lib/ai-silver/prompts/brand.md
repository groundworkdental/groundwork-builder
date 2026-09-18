You are extracting brand AESTHETIC cues from a dental practice website: colors, logo, tagline.

Do NOT extract or recommend fonts. The rebuild uses validated template / catalog typefaces later — ignore whatever the CMS uses for typography.

# Inputs

WEBSITE: {{baseUrl}}
External CSS: {{cssUrl}}

## Homepage

{{pageContext}}

## CSS color list (raw hex values from external stylesheet)

{{cssColors}}

# Output — strict JSON

```
{
  "brand": {
    "colors": {
      "primary":   "#hex — the dominant brand color (NEVER white/black/near-grey). Look for the color used on nav background, primary buttons, headings.",
      "secondary": "#hex — second most prominent brand color",
      "accent":    "#hex — accent color for CTAs / highlights, or null",
      "palette":   ["EVERY distinct brand color hex used on the site (from the CSS color list) — primary, secondary, accent, plus any additional brand hues like a dark navy, a tint, a highlight. Include all non-white/non-black brand colors, e.g. ['#107dac','#00555a','#023c55','#74c7e3']. 3-8 entries."]
    },
    "fonts": {
      "heading": null,
      "body": null
    },
    "logoPath": "URL of the practice logo image (usually in the header, alt text like 'Logo' or practice name)",
    "tagline": "Brand tagline if present in the hero or page title (e.g. 'Guiding the Way to Optimal Oral Health'); null if no tagline"
  }
}
```

# Rules

1. **colors.primary MUST NOT be:**
   - white (#fff, #ffffff, #f8f8f8, etc.)
   - near-black (#000, #111, #222, #333)
   - pure grey (e.g. #888, #999)
   Pick the actual brand color — the distinctive hue you'd describe as "the practice's color".
2. **Color hex format** — always 6 chars with leading `#`, lowercase. Expand 3-char hex (`#0af` → `#00aaff`).
3. **fonts** — always `"heading": null, "body": null`. Do not invent or copy CMS font names.
4. **logoPath** — find the `<img>` with alt containing "logo" OR alt containing the practice name OR a path like `/logo`, `/img/logo*`. Return the src.
5. **tagline** — distinct from heroTagline (a marketing headline). The brand tagline is a short identifier-style phrase the practice uses as part of its identity (often appearing under the logo or in page titles).
6. **Null over guess** — if no clear primary brand color exists, return null. Don't pick a random hex.

Return ONLY the JSON object.
