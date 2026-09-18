#!/usr/bin/env node
/**
 * test-faq-repair.js — the deterministic backstop for the faqs pass.
 *
 * Anchored to one observed loss: arts-family /dental-implants.html carries 4140
 * words, a "Dental Implant FAQs" heading, and 10 question headings, and the faqs
 * pass returned zero FAQs for it while obeying on 8 of the site's 9 other
 * FAQ-bearing pages. The prompt already said "EVERY Q+A — do not skip any",
 * which is why this layer exists: where the outcome is measurable, the guarantee
 * cannot depend on the model complying.
 *
 * The precision half matters as much as the recall half. On that same page,
 * "Why Choose Arts Family Dentistry of Dallas for Dental Implants?" is a
 * question-shaped heading over a bullet list of selling points — the only sales
 * panel among 10 real answers, and the reason this harvester requires prose.
 *
 * Deterministic, no AI, no network.
 */

import { harvestFaqs, repairFaqs, declaresFaqSection } from '../lib/ai-silver/faq-repair.js';

let failures = 0;
const check = (label, cond, extra = '') => {
  if (cond) return console.log(`  ✓ ${label}`);
  failures++;
  console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
};

const para = (text) => ({ type: 'paragraph', text });
const list = (...items) => ({ type: 'list', items });
const ANSWER = 'Unlike other tooth replacements, dental implants are designed to be permanent, and in more than 95% of cases they last for decades with routine care.';

/** /dental-implants.html in miniature: a real FAQ block plus one sales panel. */
const implantsPage = () => ({
  path: '/dental-implants.html',
  wordCount: 4140,
  bodyText: 'Dental Implant FAQs. Read the answers to a few of our most frequently asked '
    + 'dental implant questions below. Can I Take Dental Implants Out? No. How Long Do '
    + 'Dental Implants Last? Decades. Am I Too Old for Dental Implants? There is no limit.',
  headings: [
    { level: 2, text: 'Dental Implant FAQs' },
    { level: 2, text: 'Why Choose Arts Family Dentistry of Dallas for Dental Implants?' },
    { level: 3, text: 'Can I Take Dental Implants Out?' },
    { level: 3, text: 'How Long Do Dental Implants Last?' },
    { level: 3, text: 'Am I Too Old for Dental Implants?' },
  ],
  sections: [
    { heading: { type: 'heading', level: 2, text: 'Dental Implant FAQs' }, blocks: [para('As excited as you might be, we are sure you have questions first.')] },
    // The sales panel: question-shaped, list-only, no prose.
    { heading: { type: 'heading', level: 2, text: 'Why Choose Arts Family Dentistry of Dallas for Dental Implants?' },
      blocks: [list('Partnered with Skilled Oral Surgeons', 'Knowledgeable Dentists Who Listen', 'Welcoming, Comfortable Office')] },
    { heading: { type: 'heading', level: 3, text: 'Can I Take Dental Implants Out?' },
      blocks: [para('No. Once your implant dentist has surgically placed the post into your jaw, the surrounding bone begins to fuse with it.')] },
    { heading: { type: 'heading', level: 3, text: 'How Long Do Dental Implants Last?' }, blocks: [para(ANSWER)] },
    { heading: { type: 'heading', level: 3, text: 'Am I Too Old for Dental Implants?' },
      blocks: [para('There is no upper age limit for dental implants, though older patients are more likely to have bone loss to address first.')] },
  ],
});

console.log('\ndeclaresFaqSection — only pages that say they have an FAQ block');
{
  check('marker + 3 question headings qualifies', declaresFaqSection(implantsPage()));

  const noMarker = implantsPage();
  noMarker.bodyText = noMarker.bodyText.replace(/Dental Implant FAQs\. /, '').replace(/frequently asked /, '');
  noMarker.headings = noMarker.headings.filter((h) => !/FAQ/i.test(h.text));
  check('question headings without an FAQ marker do not qualify', !declaresFaqSection(noMarker));

  const twoQs = implantsPage();
  twoQs.headings = twoQs.headings.filter((h) => !/Am I Too Old/.test(h.text)).filter((h) => !/Why Choose/.test(h.text));
  check('fewer than 3 question headings does not qualify', !declaresFaqSection(twoQs));

  check('an empty page does not qualify', !declaresFaqSection({ path: '/x', bodyText: '', headings: [] }));
}

console.log('\nharvestFaqs — recall on the real answers, silence on the sales panel');
{
  const got = harvestFaqs(implantsPage());
  const questions = got.map((f) => f.question);

  check('recovers all three real answers', got.length === 3, `got ${got.length}: ${questions.join(' | ')}`);
  check('the list-only sales panel is not harvested',
    !questions.some((q) => /^Why Choose/i.test(q)), questions.join(' | '));
  check('the FAQ block heading itself is not harvested (not a question)',
    !questions.includes('Dental Implant FAQs'));
  check('answers are verbatim', got.find((f) => /How Long/.test(f.question))?.answer === ANSWER);
  check('every entry is attributed to its page', got.every((f) => f.source === '/dental-implants.html'));
  check('every entry is marked as repaired, not model output',
    got.every((f) => f.origin === 'bronze-repair'));
}

console.log('\nharvestFaqs — shapes and edges');
{
  check('no sections and no contentBlocks yields nothing', harvestFaqs({ path: '/x' }).length === 0);
  check('undefined page yields nothing', harvestFaqs().length === 0);

  // contentBlocks fallback, for pages the crawler did not group into sections.
  const flat = {
    path: '/faq',
    contentBlocks: [
      { type: 'heading', level: 2, text: 'Frequently Asked Questions' },
      { type: 'heading', level: 3, text: 'Do you take walk-ins?' },
      para('Yes, we reserve time each day for same-day emergencies and walk-in patients.'),
      { type: 'heading', level: 3, text: 'Do you offer payment plans?' },
      para('We do — we offer third-party financing as well as an in-house membership plan.'),
    ],
  };
  const fromFlat = harvestFaqs(flat);
  check('contentBlocks fallback pairs heading with following prose', fromFlat.length === 2,
    `got ${fromFlat.length}`);
  check('fallback stops the answer at the next heading',
    fromFlat[0]?.answer === 'Yes, we reserve time each day for same-day emergencies and walk-in patients.',
    fromFlat[0]?.answer);

  // A question with a one-word answer is a heading, not an FAQ.
  const thin = { path: '/x', sections: [{ heading: { level: 3, text: 'Really?' }, blocks: [para('Yes.')] }] };
  check('an answer under the length floor is skipped', harvestFaqs(thin).length === 0);

  // Duplicate questions on one page collapse.
  const dup = { path: '/x', sections: [
    { heading: { level: 3, text: 'Does it hurt?' }, blocks: [para(ANSWER)] },
    { heading: { level: 3, text: 'Does it hurt?' }, blocks: [para(ANSWER)] },
  ] };
  check('duplicate questions collapse to one', harvestFaqs(dup).length === 1);
}

console.log('\nrepairFaqs — fires only where the pass came back empty');
{
  // The observed case: the page contributed nothing.
  const silver = { content: { faqs: [{ question: 'Unrelated?', answer: 'x'.repeat(60), source: '/' }] }, meta: {} };
  const r = repairFaqs(silver, [implantsPage()]);
  check('repairs a declared-FAQ page that contributed nothing', r.added === 3, `added ${r.added}`);
  check('existing FAQs are preserved', silver.content.faqs.length === 4);
  check('the repair is recorded as a confidence flag',
    silver.meta.confidenceFlags?.some((f) => /faq-repair/.test(f)), JSON.stringify(silver.meta.confidenceFlags));
  check('the flag names the page',
    silver.meta.confidenceFlags?.some((f) => f.includes('/dental-implants.html')));

  // Already covered by source → leave alone. This is the 8-of-9 case.
  const covered = { content: { faqs: [{ question: 'Anything?', answer: 'y'.repeat(60), source: '/dental-implants.html' }] }, meta: {} };
  const r2 = repairFaqs(covered, [implantsPage()]);
  check('a page the pass already sourced is not touched', r2.added === 0, `added ${r2.added}`);
  check('no confidence flag when nothing was repaired', !covered.meta.confidenceFlags?.length);

  // Covered by question text but with no source field — must not duplicate.
  const unsourced = { content: { faqs: [
    { question: 'How Long Do Dental Implants Last?', answer: ANSWER },
    { question: 'Can I Take Dental Implants Out?', answer: 'z'.repeat(60) },
    { question: 'Am I Too Old for Dental Implants?', answer: 'z'.repeat(60) },
  ] }, meta: {} };
  const r3 = repairFaqs(unsourced, [implantsPage()]);
  check('questions already present are not duplicated even without a source', r3.added === 0,
    `added ${r3.added}: ${unsourced.content.faqs.map((f) => f.question).join(' | ')}`);

  // A page with no declared FAQ block is left alone even if it has ? headings —
  // this is what keeps "What Is Gum Recontouring?" out of content.faqs.
  const sectionHeaders = {
    path: '/gummy-smile-correction.html',
    bodyText: 'Gum recontouring reshapes the gum line for a balanced smile.',
    headings: [
      { level: 2, text: 'What Is Gum Recontouring?' },
      { level: 2, text: 'How Does Gum Recontouring Work?' },
      { level: 2, text: 'Who Is a Good Candidate?' },
    ],
    sections: [
      { heading: { level: 2, text: 'What Is Gum Recontouring?' }, blocks: [para(ANSWER)] },
      { heading: { level: 2, text: 'How Does Gum Recontouring Work?' }, blocks: [para(ANSWER)] },
      { heading: { level: 2, text: 'Who Is a Good Candidate?' }, blocks: [para(ANSWER)] },
    ],
  };
  const r4 = repairFaqs({ content: { faqs: [] }, meta: {} }, [sectionHeaders]);
  check('prose section headers are not promoted to FAQs', r4.added === 0,
    `added ${r4.added} from a page with no FAQ marker`);

  // Blog pages never reach the repair (caller passes the reference set), but an
  // absent faqs array must not throw.
  const noFaqs = { content: {}, meta: {} };
  const r5 = repairFaqs(noFaqs, [implantsPage()]);
  check('a silver with no faqs array is repaired, not crashed', r5.added === 3, `added ${r5.added}`);
  check('empty page list is a no-op', repairFaqs({ content: { faqs: [] }, meta: {} }, []).added === 0);
}

console.log(failures ? `\n${failures} assertion(s) failed\n` : '\nall assertions passed\n');
process.exit(failures ? 1 : 0);
