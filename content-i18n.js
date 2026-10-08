// content-i18n.js — translation layer for ADMIN-ENTERED content.
//
// i18n.js covers the static UI strings (buttons, labels, errors). This module covers
// the free-text content that comes from Supabase (settings, services, doctors,
// categories, banners): an exact-match dictionary of the live English strings plus a
// few regex templates for number-bearing phrases ("Free delivery above ₹499 · …").
//
// tc(text, lang) returns the hi/bho translation when known; unknown strings (and every
// string when lang === 'en') pass through unchanged, so doctor names, medicine fields,
// prices, phone numbers etc. are never altered. Node-import-safe (scripts/check.mjs
// imports it): no top-level document/localStorage access.

import { getLang } from './i18n.js';

// Normalise whitespace / punctuation so both DB variants of a string hit the same key
// (e.g. 'Medical Officer , Govt. of Bihar' and 'Medical Officer,  Govt. of Bihar').
export const norm = (s) => String(s ?? '').normalize('NFC').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/\s+\./g, '.').trim();

export const DICT = {
  // ---- Settings (hero / badges / stats / address) ----
  'Caring for Life, Healing with Heart': { hi: 'जीवन की देखभाल, दिल से उपचार', bho: 'जिनगी के देखभाल, दिल से इलाज' },
  'Expert Ayurvedic & Modern Healthcare — Gynaecology, Child Care & General Medicine under one trusted roof.': { hi: 'विशेषज्ञ आयुर्वेदिक व आधुनिक स्वास्थ्य सेवा — स्त्री रोग, शिशु देखभाल व सामान्य चिकित्सा, एक भरोसेमंद छत के नीचे।', bho: 'विशेषज्ञ आयुर्वेदिक आ आधुनिक स्वास्थ्य सेवा — स्त्री रोग, बच्चा के देखभाल आ सामान्य चिकित्सा, एके भरोसेमंद छत के नीचे।' },
  'Government of Bihar Recognized': { hi: 'बिहार सरकार द्वारा मान्यता प्राप्त', bho: 'बिहार सरकार से मान्यता प्राप्त' },
  'AYUSH Certified': { hi: 'आयुष प्रमाणित', bho: 'आयुष से प्रमाणित' },
  '24/7 Emergency': { hi: '24/7 आपातकालीन सेवा', bho: '24/7 इमरजेंसी सेवा' },
  '4.9 ★ Rating': { hi: '4.9 ★ रेटिंग', bho: '4.9 ★ रेटिंग' },
  '15,000+ Happy Patients Trust Us': { hi: '15,000+ संतुष्ट मरीज़ों का भरोसा', bho: '15,000+ खुशहाल मरीज के भरोसा' },
  'Expert Doctors': { hi: 'विशेषज्ञ डॉक्टर', bho: 'विशेषज्ञ डाक्टर' },
  'Patients Treated': { hi: 'मरीज़ों का उपचार', bho: 'मरीज के इलाज भइल' },
  'Years Experience': { hi: 'वर्षों का अनुभव', bho: 'साल के अनुभव' },
  'Satisfaction': { hi: 'संतुष्टि', bho: 'संतोष' },
  'Sri Sai Hospital Gaura Road Ander Dist- Siwan Bihar': { hi: 'श्री साई हॉस्पिटल, गौरा रोड, आंदर, ज़िला सिवान, बिहार', bho: 'श्री साई हॉस्पिटल, गौरा रोड, आंदर, जिला सिवान, बिहार' },

  // ---- Services (name | description) ----
  'Gynaecology': { hi: 'स्त्री रोग चिकित्सा', bho: 'स्त्री रोग चिकित्सा' },
  "Complete women's health including prenatal, postnatal, and reproductive care.": { hi: 'गर्भावस्था से पहले व बाद की देखभाल और प्रजनन स्वास्थ्य सहित महिलाओं की संपूर्ण स्वास्थ्य सेवा।', bho: 'गर्भ से पहिले आ बाद के देखभाल आ प्रजनन स्वास्थ्य समेत महिला लोग के पूरा स्वास्थ्य सेवा।' },
  'Child Care': { hi: 'शिशु देखभाल', bho: 'बच्चा के देखभाल' },
  'Paediatric care, vaccinations, growth monitoring, and nutrition guidance.': { hi: 'बाल चिकित्सा, टीकाकरण, विकास की निगरानी और पोषण मार्गदर्शन।', bho: 'बाल चिकित्सा, टीकाकरण, बढ़ंती के निगरानी आ पोषण के सलाह।' },
  'Ayurvedic Treatment': { hi: 'आयुर्वेदिक उपचार', bho: 'आयुर्वेदिक इलाज' },
  'Traditional AYUSH therapies for chronic conditions, immunity, and wellness.': { hi: 'पुरानी बीमारियों, रोग-प्रतिरोधक क्षमता और संपूर्ण स्वास्थ्य के लिए पारंपरिक आयुष चिकित्सा।', bho: 'पुरान बेमारी, रोग-प्रतिरोधक क्षमता आ पूरा स्वास्थ्य खातिर पारंपरिक आयुष चिकित्सा।' },
  'General Medicine': { hi: 'सामान्य चिकित्सा', bho: 'सामान्य चिकित्सा' },
  'Comprehensive diagnosis and treatment for common and complex conditions.': { hi: 'सामान्य और जटिल बीमारियों की संपूर्ण जाँच और उपचार।', bho: 'सामान्य आ जटिल बेमारी के पूरा जाँच आ इलाज।' },
  'Online Consultation': { hi: 'ऑनलाइन परामर्श', bho: 'ऑनलाइन सलाह' },
  'Virtual consultations from the comfort of your home via video call.': { hi: 'वीडियो कॉल के ज़रिए अपने घर के आराम से डॉक्टर से परामर्श।', bho: 'वीडियो कॉल से रउआ अपना घर से आराम से डाक्टर के सलाह लीं।' },
  'Emergency Services': { hi: 'आपातकालीन सेवाएँ', bho: 'इमरजेंसी सेवा' },
  'Round-the-clock emergency care and ambulance services available 24/7.': { hi: 'चौबीसों घंटे आपातकालीन देखभाल और एम्बुलेंस सेवा, 24/7 उपलब्ध।', bho: 'चौबीसो घंटा इमरजेंसी देखभाल आ एम्बुलेंस सेवा, 24/7 उपलब्ध।' },

  // ---- Doctors (specialty · title · expertise · qualifications · bio) ----
  'Child Specialist and Neonatal Care': { hi: 'शिशु रोग विशेषज्ञ व नवजात देखभाल', bho: 'बच्चा रोग विशेषज्ञ आ नवजात देखभाल' },
  'Gynaecologist': { hi: 'स्त्री रोग विशेषज्ञ', bho: 'स्त्री रोग विशेषज्ञ' },
  'Medical Officer, Govt. of Bihar': { hi: 'मेडिकल ऑफिसर, बिहार सरकार', bho: 'मेडिकल ऑफिसर, बिहार सरकार' },
  'Child Immunization': { hi: 'बाल टीकाकरण', bho: 'बच्चा के टीकाकरण' },
  'Growth Monitoring': { hi: 'विकास की निगरानी', bho: 'बढ़ंती के निगरानी' },
  'Ayurvedic Medicine & Treatment': { hi: 'आयुर्वेदिक दवा व उपचार', bho: 'आयुर्वेदिक दवाई आ इलाज' },
  'Prenatal & Postnatal Care': { hi: 'प्रसव पूर्व व प्रसवोत्तर देखभाल', bho: 'प्रसव से पहिले आ बाद के देखभाल' },
  'Fertility Consultation': { hi: 'प्रजनन (फर्टिलिटी) परामर्श', bho: 'फर्टिलिटी (संतान) सलाह' },
  'MS (Obs & Gyn)': { hi: 'MS (प्रसूति व स्त्री रोग)', bho: 'MS (प्रसूति आ स्त्री रोग)' },
  'MD GACH Patna': { hi: 'MD, GACH पटना', bho: 'MD, GACH पटना' },
  "Expert in Ayurvedic medicine & treatment and Gynaecology. Specializing in women's health with deep expertise in prenatal care, fertility treatments, and holistic women's wellness programs.": { hi: 'आयुर्वेदिक चिकित्सा व उपचार और स्त्री रोग की विशेषज्ञ। गर्भावस्था की देखभाल, प्रजनन उपचार और महिलाओं के समग्र स्वास्थ्य कार्यक्रमों में गहरा अनुभव।', bho: 'आयुर्वेदिक चिकित्सा आ इलाज आ स्त्री रोग के विशेषज्ञ। गर्भ के देखभाल, प्रजनन इलाज आ महिला लोग के समग्र स्वास्थ्य कार्यक्रम में गहिर अनुभव।' },
  'Expert in child healthcare, immunization programs, growth monitoring, nutrition guidance, and comprehensive general medicine for all age groups.': { hi: 'बाल स्वास्थ्य, टीकाकरण कार्यक्रम, विकास की निगरानी, पोषण मार्गदर्शन और हर उम्र के लिए संपूर्ण सामान्य चिकित्सा के विशेषज्ञ।', bho: 'बच्चा के स्वास्थ्य, टीकाकरण कार्यक्रम, बढ़ंती के निगरानी, पोषण के सलाह आ हर उमिर खातिर पूरा सामान्य चिकित्सा के विशेषज्ञ।' },

  // ---- Pharmacy categories ('Child Care' is listed under Services) ----
  'Immunity & Wellness': { hi: 'इम्युनिटी व स्वास्थ्य', bho: 'इम्युनिटी आ स्वास्थ्य' },
  'Digestive Care': { hi: 'पाचन देखभाल', bho: 'पाचन के देखभाल' },
  "Women's Health": { hi: 'महिला स्वास्थ्य', bho: 'महिला स्वास्थ्य' },
  'Joint & Pain Relief': { hi: 'जोड़ व दर्द निवारण', bho: 'जोड़ आ दरद से राहत' },
  'Skin & Hair': { hi: 'त्वचा व बाल', bho: 'त्वचा आ बाल' },
  'Churna & Powders': { hi: 'चूर्ण व पाउडर', bho: 'चूर्ण आ पाउडर' },
  'Asava & Arishta': { hi: 'आसव व अरिष्ट', bho: 'आसव आ अरिष्ट' },
  'Oils & Tailam': { hi: 'तेल व तैलम', bho: 'तेल आ तैलम' },
  'Heart & Vitality': { hi: 'हृदय व ऊर्जा', bho: 'हृदय आ ताकत' },

  // ---- Banners (title | subtitle) + template remainders ----
  'Ayurvedic Pharmacy': { hi: 'आयुर्वेदिक दवाखाना', bho: 'आयुर्वेदिक दवाखाना' },
  'Free delivery above ₹499 · Classical formulations': { hi: '₹499 से ऊपर मुफ़्त डिलीवरी · शास्त्रोक्त औषधियाँ', bho: '₹499 से ऊपर फ्री डिलीवरी · शास्त्रोक्त दवाई' },
  'Consult Our Doctors': { hi: 'हमारे डॉक्टरों से परामर्श लें', bho: 'हमार डाक्टर से सलाह लीं' },
  'In-person ₹300 · Online video ₹200': { hi: 'क्लिनिक पर ₹300 · ऑनलाइन वीडियो ₹200', bho: 'अस्पताल में ₹300 · ऑनलाइन वीडियो ₹200' },
  'Immunity Season Sale': { hi: 'इम्युनिटी सीज़न सेल', bho: 'इम्युनिटी सीजन सेल' },
  'Up to 25% off Chyawanprash & more': { hi: 'च्यवनप्राश व अन्य पर 25% तक छूट', bho: 'च्यवनप्राश आ अउरी पर 25% तक छूट' },
  'Classical formulations': { hi: 'शास्त्रोक्त औषधियाँ', bho: 'शास्त्रोक्त दवाई' },
  'Chyawanprash & more': { hi: 'च्यवनप्राश व अन्य', bho: 'च्यवनप्राश आ अउरी' },
};

// Fallbacks for number-bearing phrases when the exact string misses.
// {n} = regex group n (copied as-is); groups listed in `text` are free text and get tc()'d.
export const TEMPLATES = [
  { re: /^Free delivery above (₹\s?[\d,]+)\s*·\s*(.+)$/i, hi: '{1} से ऊपर मुफ़्त डिलीवरी · {2}', bho: '{1} से ऊपर फ्री डिलीवरी · {2}', text: [2] },
  { re: /^Free delivery above (₹\s?[\d,]+)$/i, hi: '{1} से ऊपर मुफ़्त डिलीवरी', bho: '{1} से ऊपर फ्री डिलीवरी' },
  { re: /^In-person (₹\s?[\d,]+)\s*·\s*Online video (₹\s?[\d,]+)$/i, hi: 'क्लिनिक पर {1} · ऑनलाइन वीडियो {2}', bho: 'अस्पताल में {1} · ऑनलाइन वीडियो {2}' },
  { re: /^Up to (\d+)% off (.+)$/i, hi: '{2} पर {1}% तक छूट', bho: '{2} पर {1}% तक छूट', text: [2] },
  { re: /^Up to (\d+)% off$/i, hi: '{1}% तक छूट', bho: '{1}% तक छूट' },
  { re: /^([\d,]+\+?) Happy Patients Trust Us$/i, hi: '{1} संतुष्ट मरीज़ों का भरोसा', bho: '{1} खुशहाल मरीज के भरोसा' },
  { re: /^([\d.]+) ★ Rating$/i, hi: '{1} ★ रेटिंग', bho: '{1} ★ रेटिंग' },
  { re: /^(\d+)\/(\d+) Emergency$/i, hi: '{1}/{2} आपातकालीन सेवा', bho: '{1}/{2} इमरजेंसी सेवा' },
];

const INDEX = new Map(Object.entries(DICT).map(([k, v]) => [norm(k).toLowerCase(), v]));

// Translate a piece of admin content. Unknown text (or lang 'en') is returned untouched.
export function tc(text, lang = getLang()) {
  if (lang === 'en' || typeof text !== 'string') return text;
  const key = norm(text);
  if (!key) return text;
  const hit = INDEX.get(key.toLowerCase());
  if (hit && hit[lang]) return hit[lang];
  for (const tpl of TEMPLATES) {
    const m = key.match(tpl.re);
    if (m) return tpl[lang].replace(/\{(\d)\}/g, (_, i) => (tpl.text && tpl.text.includes(Number(i)) ? tc(m[i], lang) : (m[i] ?? '')));
  }
  return text;
}
