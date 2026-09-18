/**
 * Google Business Profile — the listing's intended state, as config.
 *
 * A listing managed by hand is a set of facts nobody can review, diff, or
 * carry to the next practice. This file is what the listing SHOULD say; the
 * `gbp consistency` gate compares it against src/config/site.ts so the two
 * can never drift, and a future scripts/gbp.mjs will diff it against what
 * Google actually serves.
 *
 * Three rules govern what belongs here:
 *
 *   Derive, never retype. Hours, phone and address come from site.ts. If a
 *   fact has a home, this file references it rather than restating it.
 *
 *   Record what is LIVE, not what was proposed. A config describing an
 *   imagined listing is worse than no config, because the next person pushes
 *   it to Google.
 *
 *   Omit what is unknown. A wrong value here gets published.
 */

import { site, address, hours } from './site';

export const gbp = {
  /**
   * Google's own identifier for the location. Public and stable, and any
   * automation needs it to address the location. Keep it even though nothing
   * reads it yet.
   */
  locationId: '',

  /**
   * The CID embedded in site.googleProfileLink must resolve to THIS listing.
   * Verify it by opening the link rather than trusting it — a wrong CID
   * points your structured data's sameAs at another business, silently.
   */
  verifiedCid: '',

  /** Primary category first, exactly as Google names it. */
  categories: {
    primary: '',
    additional: [] as string[],
  },

  /**
   * 750 characters, hard cap, and the counter in Google's editor is the
   * authority — verify against it rather than a local count.
   *
   * Google rejects descriptions containing URLs, phone numbers, prices or
   * promotional language ("call now", "best in town", "$99 special").
   *
   * Lead with what the practice is and where: the first ~100 characters are
   * what truncates into the mobile panel.
   */
  description: '',

  /**
   * Services, nested per category, as Google stores them. Each category
   * should carry at least one service or it renders as an empty heading.
   */
  services: [] as Array<{ category: string; items: Array<{ name: string; description?: string }> }>,

  /**
   * Claims about a physical office, and not ours to guess. An unverified
   * accessibility claim sends a patient to a door they may not get through.
   *
   * Ship empty and keep empty until someone confirms. Do not infer from the
   * building, the floor plan, or other listings nearby. The build surfaces
   * these as a recurring warning and never as a failure — a reminder that
   * blocks a deploy gets silenced within a week.
   */
  attributes: {
    /** Needs someone physically at the office. */
    needsSiteVisit: {
      wheelchairAccessibleEntrance: null as boolean | null,
      wheelchairAccessibleRestroom: null as boolean | null,
      wheelchairAccessibleParking: null as boolean | null,
    },
    /** Answerable by phone. */
    answerableByPhone: {
      acceptsNewPatients: null as boolean | null,
      appointmentRequired: null as boolean | null,
      languagesSpoken: [] as string[],
    },
  },

  /** Derived — never retyped. The site and the listing cannot drift if only one declares the fact. */
  derived: {
    name: site.name,
    phone: site.phoneE164,
    address: `${address.street}, ${address.city}, ${address.state} ${address.zip}`,
    hours: hours.schema,
    /**
     * The website link Google serves. UTM tags are what separate listing
     * traffic from the rest of organic in GA4.
     */
    websiteUrl: `${site.url}?utm_source=google&utm_medium=organic&utm_campaign=gbp`,
  },
} as const;

export default gbp;
