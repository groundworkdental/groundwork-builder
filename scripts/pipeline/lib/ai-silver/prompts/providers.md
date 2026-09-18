You are extracting EVERY provider (doctor + non-doctor staff) listed on a dental practice website.

# Inputs

WEBSITE: {{baseUrl}}

## Pages (team/staff/doctor bio pages + homepage, with full body text)

{{pageContext}}

## Person / Dentist JSON-LD found across the site

{{personLdJson}}

## Image candidates for headshots (selected by alt/src patterns)

{{photoCandidates}}

# Required output

Return ONE strict JSON object with two arrays: `doctors[]` and `staff[]`. Strict JSON — every embedded `"` MUST be backslash-escaped. No markdown, no comments, no trailing commas.

```
{
  "doctors": [
    {
      "name": "Full name including Dr. prefix exactly as it appears (e.g. 'Dr. Cha Ae (Gloria) Hur')",
      "firstName": "First given name (no Dr., no title)",
      "lastName": "Last name",
      "credentials": "Credentials line as written (e.g. 'DDS', 'DMD, MS, FACD', 'BDS, MS, FACD')",
      "bio": "FULL bio paragraph(s), verbatim. Copy every sentence the source provides about this provider. Concatenate multiple paragraphs with \\n\\n. null if no bio prose exists for this person",
      "educationList": [
        "One entry per education/training credential, verbatim. e.g. 'Doctorate of Dental Surgery — University of Southern California'",
        "..."
      ],
      "certifications": [
        "One entry per board certification / advanced training. e.g. 'Board Certified Diplomate, American Board of Orthodontics (2007)'"
      ],
      "specialties": ["List focus areas/specialties mentioned (e.g. 'Pediatric Dentistry')"],
      "organizations": [
        "One entry per professional membership. e.g. 'American Dental Association', 'American Academy of Pediatric Dentistry'"
      ],
      "languages": ["Languages spoken if mentioned (e.g. 'English', 'Spanish'); empty array if not stated"],
      "statusNote": "VERBATIM status text if present: 'retiring after 39 years', 'joined the practice September 2026', 'in continuous private practice for more than 35 years', 'now seeing patients at our Long Beach office'. null if no status descriptor",
      "boardCertified": true | false | null,
      "photoUrl": "URL of this provider's headshot — match by name in alt text or filename (e.g. /img-dr-cortez.jpg → Dr. Cortez). null if not found",
      "photoAlt": "alt text of the matched photo if any, else null",
      "sourcePath": "Page path where this provider's bio appears (e.g. '/meet-dr-cortez.php')",
      "rank": 1
    }
  ],
  "staff": [
    {
      "name": "Name as it appears (no Dr. prefix — these are non-doctor team members)",
      "role": "hygienist | assistant | receptionist | office_manager | treatment_coordinator | financial_coordinator | other",
      "roleLabel": "Verbatim role label from the site (e.g. 'Office Manager', 'Treatment Coordinator')",
      "bio": "Short bio if present, else null",
      "credentials": "Verbatim credentials line if any (e.g. 'RDH', 'CDA'); else null",
      "languages": ["Languages if stated; else empty"],
      "photoUrl": "URL of this staff member's photo — match by name in alt text, or alt starting with 'Staff member:'. null if not found",
      "photoAlt": "alt text of the matched photo if any",
      "sourcePath": "Page path where this person is listed"
    }
  ]
}
```

# Hard rules — read every one

1. **REAL PROVIDERS ONLY** — include a doctor when they have (a) a dedicated bio page (`/dr-…`, `/meet-dr-…`) OR (b) a substantial first-person bio paragraph about them. Do NOT invent providers from marketing blurbs, stale template copy, or first-name-only mentions (e.g. "Dr. Zach y la Dra. Sara"). Departing/retiring providers with real bios are still included — status is a downstream decision.
2. **VERBATIM** — bios, education entries, certifications, status notes are copied exactly as written. Do not paraphrase, summarize, or improve grammar.
3. **NULL OVER FABRICATION** — if a provider has no bio paragraph on the site, set `bio: null`. NEVER substitute the practice's mission/about/welcome paragraph as their bio. Prefer omitting them entirely if they lack a dedicated page AND a real bio.
4. **statusNote is the gatekeeper for status info** — if the site says "Dr. Smith is retiring after 30 years" or "Dr. Jones joined us in 2024" or "Dr. Brown has been in continuous practice for 40 years", copy that exact phrase into `statusNote`. Do NOT exclude the provider based on the status.
5. **DOCTORS vs STAFF** — anyone with DDS/DMD/MD/BDS or addressed as "Dr." goes in `doctors[]`. Hygienists (RDH), assistants (DA/CDA/RDA), front-office, treatment coordinators go in `staff[]`.
6. **FULL NAME REQUIRED** — `firstName` + `lastName` must both be real name parts (not "Zach" alone with null lastName). Skip first-name-only mentions.
7. **Photo matching** — match a provider photo when:
   - alt text mentions their first OR last name
   - filename includes their name fragment (e.g. `img-dr-cortez.jpg` → Dr. Cortez)
   - alt text starts with "Staff member:" → staff bucket
   If multiple matches, pick the one whose alt/src best identifies the person. If no clear match, set photoUrl null rather than guess.
8. **educationList ENTRIES ARE SEPARATE** — split each degree/certificate/cert program into its own array entry. Do not collapse "DDS USC; pediatric cert Yale" into one string.
9. **rank** — for `doctors[]`, assign `rank: 1, 2, 3, ...` in the order they appear on the site (or in source-order on the team/about page). Rank is a presentation hint, NOT a status filter.
10. **No primary distinction** — do NOT pick a "primary" doctor. Every provider is equally captured.
11. **JSON-LD priority** — if `Person`/`Dentist` JSON-LD exists, prefer it for name/credentials but still pull bio from the visible bio paragraph on the page.
12. **Empty arrays, never omit** — if a provider has no `certifications`, return `"certifications": []`. Do not omit the key.
13. **Credentials: capture the FULL string verbatim** — the letters that follow a provider's name (e.g. "DDS, MS, FACD, ICD", "DMD, MS"). Look right after the name in headings, bios, and page titles. Each doctor almost always has a credentials string — find it. Do not leave credentials null if any letters appear after the name anywhere on the site.
14. **Staff organizations/memberships** — if a staff member's bio lists professional memberships (e.g. "member of the American Dental Hygiene Association, California Dental Hygienists' Association"), capture them in that staff member's `organizations[]` (add the field for staff too).
15. **Ignore soft-404 / clone pages** — if a "meet-dr" URL clearly reprints the homepage (same boilerplate), do not treat names mentioned only there as providers.

Return ONLY the JSON object.
