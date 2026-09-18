You are extracting hero copy, about/mission/philosophy paragraphs, value props, stats, and any distinctive content from a dental practice website.

# Inputs

WEBSITE: {{baseUrl}}

## Pages (homepage + about + philosophy + technology + welcome pages, with full body text)

{{pageContext}}

## Candidate patient-form links (detected from link hrefs/text)

{{formLinks}}

## Area-served heading candidates (from areas-we-serve / location pages)

{{areaHints}}

# Output — strict JSON

```
{
  "content": {
    "heroTagline":     "Main hero/banner headline — short, identifier-style (e.g. 'Creating the Perfect Smile for Your Family')",
    "heroHeadline":    "Largest hero text — often the same as heroTagline; copy verbatim",
    "heroSubheadline": "Supporting hero subtext / secondary line — JOIN multi-line hero fragments here (e.g. 'Guiding the Way to' + 'Optimal Oral Health' → 'Guiding the Way to Optimal Oral Health' — but if the practice has DISTINCT lines like 'Family-friendly dental care' as a true subheadline, use that)",
    "ctaText":         "Primary CTA button text on the home/hero (e.g. 'Request Appointment'); null if none",
    "ctaSecondaryText":"Secondary CTA text if present (e.g. 'Call Us', 'Learn More'); null if none",
    "valueProp":       "Practice's core value proposition in 1 sentence — usually the homepage intro paragraph",
    "aboutText":       "Full about-us / who-we-are / welcome paragraph(s), verbatim. May be multi-paragraph; join with \\n\\n",
    "aboutHeadline":   "About-section headline if present (e.g. 'Welcome to Our Practice', 'About Our Office')",
    "philosophy":      "Care philosophy / mission statement / approach paragraph(s), verbatim. Often on a dedicated philosophy page",
    "closingCTA":      "Closing call-to-action text from footer of long pages (e.g. 'Schedule your visit today'); null if none",
    "stats": {
      "yearsExperience": 35,
      "happyPatients":   null,
      "googleRating":    null,
      "fiveStarReviews": null
    },
    "patientForms": [
      { "label": "Form name as shown (e.g. 'New Patient Form (English)', '6 Month Checkup Form')", "url": "link URL", "language": "English | Spanish | null" }
    ],
    "areasServed": [
      "EVERY city/neighborhood/region the practice mentions serving — INCLUDING its own home city if the copy says it serves that area (e.g. 'over 40 years of care in Los Alamitos' → include 'Los Alamitos'; 'serving Long Beach and surrounding communities' → include 'Long Beach'). Also include nearby areas named on areas-served/location pages (e.g. 'Huntington Beach', 'Fountain Valley')."
    ],
    "additionalContent": [
      {
        "type": "philosophy | welcome | pullquote | mission | technology | community | specialty-deep-dive | treatment-detail | first-visit | patient-experience | accessibility | multilingual | blog-post | sustainability | section-title | tagline | promotion | offer",
        "title": "The h1/h2/h3 above this content, or section heading",
        "content": "Verbatim paragraph(s), up to ~1500 chars. Multi-paragraph joined with \\n\\n",
        "source": "Page path where this content lives"
      }
    ],
    "sectionTitles": [
      "VERBATIM named section/page titles that carry brand identity — e.g. a blog titled 'Long Beach Dental Blog', a gallery section called 'Smile Designs', an offers section 'New Patient Special'. Capture the distinctive NAME the practice gave the section (from H1/H2/H3 headings), not the generic page title."
    ],
    "taglines": [
      "VERBATIM marketing taglines, promotional claims, and value-prop phrases displayed on the site — e.g. 'Top Rated 5 Star Dentist in Long Beach', 'Free second opinion on any treatment', 'Same-day emergency appointments', '$99 New Patient Special'. Short distinctive promotional copy that isn't the hero headline."
    ]
  }
}
```

# Rules

1. **VERBATIM** — copy text exactly as on the site. Do not paraphrase or condense.
2. **heroTagline / heroHeadline** — these are usually the H1 or hero-class element at the top of the homepage. If split across two DOM nodes (e.g. "Guiding the Way to" + "Optimal Oral Health"), JOIN them into a single string.
3. **stats** — `yearsExperience` should be a number if the site states "over X years", "since Y" (compute Y to now), "X+ years in practice". `googleRating` like 4.9, `fiveStarReviews` like 250.
4. **additionalContent** is for DISTINCTIVE content that doesn't fit `aboutText` / `philosophy` directly — things like:
   - dedicated "Technology" page describing equipment
   - "Why Pediatric" or "Why Orthodontics" specialty rationale
   - community/charitable involvement paragraphs
   - "What to Expect at Your First Visit" walkthroughs
   - Mission/values lists
   - Sustainability or eco-friendly statements
   Capture each distinct content block as one entry. Cap at {{acCap}} entries.
   The cap is a ceiling, not a target: return what the site actually has. If the
   practice only has four distinct blocks worth keeping, return four.
5. **No fabrication** — every value comes from the page text. Null if absent.
6. **stats inference** — "over 30 years serving Long Beach" maps to yearsExperience: 30. "Since 1989" → years from 1989 to current year. If unsure, null.

Return ONLY the JSON object.
