-- Seed the Study Mind "Reconnect" partner-school list into the B2B CRM.
--
-- Source: the operator's "Study Mind Reconnect All Clients" workbook — schools
-- we have worked with before and want the team to re-engage in 2026. Each row
-- becomes a BusinessAccount(kind='school') so it appears on /accounts, carrying
-- the school's key contact, email, the services we previously ran, the years we
-- worked together and the reconnect status in its notes (CLAUDE.md §37 B2B).
--
-- DEDUP-SAFE (the operator already has schools in the CRM): every insert is
-- guarded by NOT EXISTS against any existing school account whose name matches.
-- Three high-precision tests (all case/punctuation-insensitive):
--   1. exact match on alphanumerics-only ("St. Peter's" == "St Peters"),
--   2. same slug (however the existing account was named),
--   3. whole-word leading-prefix either direction — catches long/short forms
--      like "ACS International" vs "ACS International Schools", or "Rugby" vs
--      "Rugby School", WITHOUT the mid-token false match "Leyton"/"Leytonstone"
--      (the prefix must land on a word boundary, so "leytonstone" != "leyton ").
-- Nothing is ever overwritten. IDEMPOTENT: fixed ids + ON CONFLICT DO NOTHING,
-- so a re-run converges. System write — createdById/updatedById null (§19).
--
-- Forward-only data migration; mirrors the existing seed-migration pattern
-- (20260719200000_seed_dd_recovery_templates, 20260722130000 ANZ board seed).

INSERT INTO "BusinessAccount" (
  "id", "kind", "name", "slug", "status", "contactEmail", "country",
  "description", "notes", "createdAt", "updatedAt"
)
SELECT
  i."id",
  'school'::"BusinessAccountKind",
  i."name",
  i."slug",
  i."status"::"BusinessAccountStatus",
  i."contactEmail",
  i."country",
  i."description",
  i."notes",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (
  VALUES
    ('ba_reconnect_acs-international', 'ACS International', 'acs-international', 'active', NULL, 'United Kingdom', 'ACS International Schools, group of independent schools, UK (Cobham/Hillingdon/Egham)', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: E Kwan
Services previously provided: Interview
Years engaged: 2022-2023, 2024
Last year worked together: 2024
Location / description: ACS International Schools, group of independent schools, UK (Cobham/Hillingdon/Egham)
Reconnect status: Already made deal for 2026'),
    ('ba_reconnect_archbishop-holgate', 'Archbishop Holgate', 'archbishop-holgate', 'paused', 'mcharlton@ahs.pmat.academy', 'United Kingdom', 'Archbishop Holgate''s C of E School, York (Pathfinder MAT)', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: M Charlton
Contact email: mcharlton@ahs.pmat.academy
Services previously provided: UCAT
Years engaged: 2024
Last year worked together: 2024
Location / description: Archbishop Holgate''s C of E School, York (Pathfinder MAT)
Reconnect status: Last messaged 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_aston-manor', 'Aston Manor', 'aston-manor', 'paused', NULL, 'United Kingdom', 'Aston Manor Academy, secondary school, Birmingham', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: M John
Services previously provided: UCAT
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Aston Manor Academy, secondary school, Birmingham
Reconnect status: Last messaged 14/05
Notes: mjohn wasn''t found at astonmanoracademy.com'),
    ('ba_reconnect_aylward-academy', 'Aylward Academy', 'aylward-academy', 'active', 'mwright@liftaylward.org', 'United Kingdom', 'Aylward Academy, secondary, Edmonton London (LIFT MAT)', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: M Wright
Contact email: mwright@liftaylward.org
Services previously provided: OXB, TMUA
Years engaged: 2025
Last year worked together: 2025
Location / description: Aylward Academy, secondary, Edmonton London (LIFT MAT)
Reconnect status: No need to recontact speaking to hem
Notes: Sorting a deal for 2026'),
    ('ba_reconnect_bisr', 'BISR', 'bisr', 'paused', 'sdamaree@bisr.com.sa', 'Saudi Arabia', 'British International School Riyadh, 7 campuses, Saudi Arabia', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: S Damaree
Contact email: sdamaree@bisr.com.sa
Services previously provided: AL, Interview, MM INT, MM INT/OXB INT, MM/OM Int, OXB
Years engaged: 2024, 2025
Last year worked together: 2025
Location / description: British International School Riyadh, 7 campuses, Saudi Arabia'),
    ('ba_reconnect_barclay', 'Barclay', 'barclay', 'paused', 's.o''sullivan@barclay.futureacademies.org', 'United Kingdom', 'Barclay Academy, Stevenage (Future Academies Trust)', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: S O''Sullivan
Contact email: s.o''sullivan@barclay.futureacademies.org
Services previously provided: AL
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Barclay Academy, Stevenage (Future Academies Trust)
Reconnect status: Last messaged 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_beal-high', 'Beal High', 'beal-high', 'paused', 'nmatharu@bealhighschool.co.uk', 'United Kingdom', 'Beal High School, Ilford', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: N Matharu
Contact email: nmatharu@bealhighschool.co.uk
Services previously provided: OXB
Years engaged: 2025
Last year worked together: 2025
Location / description: Beal High School, Ilford
Reconnect status: Last messaged 14/05'),
    ('ba_reconnect_bedford-school', 'Bedford School', 'bedford-school', 'paused', 'efoxjohnson@bedfordschool.org.uk', 'United Kingdom', 'Bedford School, independent boys boarding/day, Bedford', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: E Fox-Johnson
Contact email: efoxjohnson@bedfordschool.org.uk
Services previously provided: UCAT
Years engaged: 2025
Last year worked together: 2025
Location / description: Bedford School, independent boys boarding/day, Bedford
Reconnect status: Last messaged 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_belle-vue', 'Belle Vue', 'belle-vue', 'active', NULL, 'United Kingdom', 'Likely Belle Vue Boys/Girls School, Bradford', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: T Mahmood
Services previously provided: UCAT
Years engaged: 2025
Last year worked together: 2025
Location / description: Likely Belle Vue Boys/Girls School, Bradford
Reconnect status: Already made deal 2026'),
    ('ba_reconnect_berkhamsted', 'Berkhamsted', 'berkhamsted', 'paused', 'nthomas@berkhamsted.com', 'United Kingdom', 'Berkhamsted School, independent, Hertfordshire', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: N Thomas
Contact email: nthomas@berkhamsted.com
Services previously provided: Int, Interview
Years engaged: 2022-2023, 2025
Last year worked together: 2025
Location / description: Berkhamsted School, independent, Hertfordshire
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_bonn-international', 'Bonn International', 'bonn-international', 'paused', 'sara.miletic@bonn-is.de', 'Germany', 'Bonn International School, international school in Germany', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: S Miletic
Contact email: sara.miletic@bonn-is.de
Services previously provided: Interview
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Bonn International School, international school in Germany
Reconnect status: Yes - 15/05 Followed up: 25/05
Notes: sara.miletic@bonn-is.de the address couldn''t be found or is unable to receive email.'),
    ('ba_reconnect_brentwood', 'Brentwood', 'brentwood', 'paused', 'jso@brentwood.essex.sch.uk', 'United Kingdom', 'Brentwood School, independent, Essex', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: J O''Connell
Contact email: jso@brentwood.essex.sch.uk
Services previously provided: UCAT
Years engaged: 2024, 2025
Last year worked together: 2025
Location / description: Brentwood School, independent, Essex
Reconnect status: Yes
Notes: School has decided to discontinue funding UCAT practice for students due to concerns around student ownership and engagement with their learning. They plan to monitor how this approach works moving forward and indicated they may reconsider in the future if outcomes are not as expected. Potential opportunity for re-engagement later'),
    ('ba_reconnect_camborne-science-and-international-academy', 'Camborne Science and International Academy', 'camborne-science-and-international-academy', 'paused', 'chapmand@cambornescience.co.uk', 'United Kingdom', 'State secondary + sixth form, Cornwall', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: D Chapman
Contact email: chapmand@cambornescience.co.uk
Email details (as recorded): Daniel Chapman <chapmand@cambornescience.co.uk>
Services previously provided: UCAT
Years engaged: 2022-2023, 2024, 2025
Last year worked together: 2025
Location / description: State secondary + sixth form, Cornwall
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_cannock-chase', 'Cannock Chase', 'cannock-chase', 'paused', 'd.vijayan@cannockchasehigh.com', 'United Kingdom', 'Cannock Chase High School, Staffordshire', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: D Vijayan
Contact email: d.vijayan@cannockchasehigh.com
Services previously provided: OXB
Years engaged: 2025
Last year worked together: 2025
Location / description: Cannock Chase High School, Staffordshire
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_canterbury-academy', 'Canterbury Academy', 'canterbury-academy', 'paused', 'jhitchcock@canterbury.kent.sch.uk', 'United Kingdom', 'The Canterbury Academy, Kent', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: J Hitchcock
Contact email: jhitchcock@canterbury.kent.sch.uk
Services previously provided: AL
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: The Canterbury Academy, Kent
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_chigwell', 'Chigwell', 'chigwell', 'paused', NULL, 'United Kingdom', 'Chigwell School, independent, Essex', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: S Coppell
Services previously provided: UCAT
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Chigwell School, independent, Essex
Notes: Can''t find email thread with school and contact person'),
    ('ba_reconnect_city-academy', 'City Academy', 'city-academy', 'paused', 'jwong@cityacademy.co.uk', 'United Kingdom', 'The City Academy (likely Bristol or Hackney)', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: K Rogan (Finance Manager)
Contact email: jwong@cityacademy.co.uk
Email details (as recorded): Jonathan Wong (Biomedical & Oxbridge Admissions Programme Director) jwong@cityacademy.co.uk
Services previously provided: UCAT
Years engaged: 2022-2023, 2024
Last year worked together: 2024
Location / description: The City Academy (likely Bristol or Hackney)
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_clevedon-school', 'Clevedon School', 'clevedon-school', 'paused', 'cblake@clevedonschool.org.uk', 'United Kingdom', 'Clevedon School, state secondary + sixth form, North Somerset', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: K Whiting (left after end of the term)
Contact email: cblake@clevedonschool.org.uk
Email details (as recorded): New contact: Chris Blake cblake@clevedonschool.org.uk
Services previously provided: AL
Years engaged: 2024
Last year worked together: 2024
Location / description: Clevedon School, state secondary + sixth form, North Somerset
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_corby-technical', 'Corby Technical', 'corby-technical', 'paused', NULL, 'United Kingdom', 'Corby Technical School, Northants', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: A Hallas
Services previously provided: UCAT
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Corby Technical School, Northants
Notes: Can''t find email thread with school and contact person'),
    ('ba_reconnect_djanogly', 'Djanogly', 'djanogly', 'paused', 'j.irons@djanogly.notts.sch.uk', 'United Kingdom', 'Djanogly Learning Trust / City Academy, Nottingham', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: M Stewart
Contact email: j.irons@djanogly.notts.sch.uk
Services previously provided: DJINT, UCAT
Years engaged: 2024, 2025
Last year worked together: 2025
Location / description: Djanogly Learning Trust / City Academy, Nottingham
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_drayton-manor', 'Drayton Manor', 'drayton-manor', 'paused', 'rbn@draytonmanorhighschool.co.uk', 'United Kingdom', 'Drayton Manor High School, Ealing', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: C Young
Contact email: rbn@draytonmanorhighschool.co.uk
Email details (as recorded): R Boniface: rbn@draytonmanorhighschool.co.uk
Services previously provided: Interview
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Drayton Manor High School, Ealing
Reconnect status: Yes - 25/05 Followed up: 02/06
Notes: Can''t find email thread with C Young, only with R Boniface: rbn@draytonmanorhighschool.co.uk'),
    ('ba_reconnect_eastbourne-college', 'Eastbourne College', 'eastbourne-college', 'paused', 'sjgordon@eastbourne-college.co.uk', 'United Kingdom', 'Eastbourne College, independent boarding/day, East Sussex', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: S Gordon
Contact email: sjgordon@eastbourne-college.co.uk
Other emails: finance@eastbourne-college.co.uk
Email details (as recorded): finance@eastbourne-college.co.uk Sarah Gordon: SJGordon@eastbourne-college.co.uk
Services previously provided: UCAT
Years engaged: 2025
Last year worked together: 2025
Location / description: Eastbourne College, independent boarding/day, East Sussex
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_eton-college', 'Eton College', 'eton-college', 'paused', NULL, 'United Kingdom', 'Eton College, independent boys boarding, Berkshire', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: S Shields
Services previously provided: Interview
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Eton College, independent boys boarding, Berkshire
Notes: Can''t find email thread with school and S Shields'),
    ('ba_reconnect_ferndown', 'Ferndown', 'ferndown', 'paused', 'katieraisbeck@fernup.dorset.sch.uk', 'United Kingdom', 'Ferndown Upper School, Dorset', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: K Raisbeck
Contact email: katieraisbeck@fernup.dorset.sch.uk
Services previously provided: Interview
Years engaged: 2024
Last year worked together: 2024
Location / description: Ferndown Upper School, Dorset
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_greater-peterborough-utc', 'Greater Peterborough UTC', 'greater-peterborough-utc', 'paused', NULL, 'United Kingdom', 'University Technical College, Peterborough', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: Lauren Barney
Services previously provided: UCAT
Years engaged: 2025
Last year worked together: 2025
Location / description: University Technical College, Peterborough
Notes: Can''t find email thread with the school and Lauren'),
    ('ba_reconnect_gunnersbury', 'Gunnersbury', 'gunnersbury', 'paused', 'headteacher@gunnersbury.hounslow.sch.uk', 'United Kingdom', 'Gunnersbury Catholic School, Hounslow', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: K Burke
Contact email: headteacher@gunnersbury.hounslow.sch.uk
Services previously provided: Interview
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Gunnersbury Catholic School, Hounslow
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_harris-rainham', 'Harris Rainham', 'harris-rainham', 'paused', 'j.holland@harrisrainham.org.uk', 'United Kingdom', 'Harris Academy Rainham, Havering (Harris Federation)', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: J Holland
Contact email: j.holland@harrisrainham.org.uk
Services previously provided: UCAT
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Harris Academy Rainham, Havering (Harris Federation)
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_henry-cort', 'Henry Cort', 'henry-cort', 'paused', 'bep@henrycort.org', 'United Kingdom', 'Henry Cort Community College, Fareham, Hampshire', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: B Parker
Contact email: bep@henrycort.org
Services previously provided: AL
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Henry Cort Community College, Fareham, Hampshire
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_houston-british-international', 'Houston British International', 'houston-british-international', 'paused', 'paula.cooper@houston.nae.school', 'United States', 'British International School of Houston, Texas USA', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: P Cooper
Contact email: paula.cooper@houston.nae.school
Services previously provided: Interview
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: British International School of Houston, Texas USA
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_hymers', 'Hymers', 'hymers', 'paused', 'mmcteare@hymers.org', 'United Kingdom', 'Hymers College, independent, Hull', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: M McTeare
Contact email: mmcteare@hymers.org
Services previously provided: UCAT
Years engaged: 2024
Last year worked together: 2024
Location / description: Hymers College, independent, Hull
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_isf-waterloo', 'ISF Waterloo', 'isf-waterloo', 'paused', 'c.steyn@isfwaterloo.org', 'Belgium', 'International school, Brussels area, Belgium', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: C Steyn
Contact email: c.steyn@isfwaterloo.org
Services previously provided: Interview
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: International school, Brussels area, Belgium
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_immanuel-college', 'Immanuel College', 'immanuel-college', 'paused', NULL, 'United Kingdom', 'Immanuel College, independent Jewish school, Bushey', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: J Welding
Services previously provided: UCAT
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Immanuel College, independent Jewish school, Bushey
Notes: Can''t find email thread with the school and contact person'),
    ('ba_reconnect_institute-rosenberg', 'Institute Rosenberg', 'institute-rosenberg', 'paused', NULL, 'Switzerland', 'Institut auf dem Rosenberg, prestigious boarding school, St Gallen, Switzerland', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: A Gademann
Services previously provided: Interview
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Institut auf dem Rosenberg, prestigious boarding school, St Gallen, Switzerland
Notes: Can''t find email thread with the school and contact person'),
    ('ba_reconnect_john-frost', 'John Frost', 'john-frost', 'paused', 'shintonc1@newportschools.wales', 'United Kingdom', 'John Frost School, Newport, Wales', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: C Shinton
Contact email: shintonc1@newportschools.wales
Services previously provided: UCAT
Years engaged: 2024
Last year worked together: 2024
Location / description: John Frost School, Newport, Wales
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_kyuem', 'KYUEM', 'kyuem', 'active', NULL, 'Malaysia', 'Kolej Yayasan UEM, pre-university A-level college, Malaysia', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: Nurulhana
Services previously provided: UCAT
Years engaged: 2025
Last year worked together: 2025
Location / description: Kolej Yayasan UEM, pre-university A-level college, Malaysia
Reconnect status: Already made deal in 2026'),
    ('ba_reconnect_kelvinside', 'Kelvinside', 'kelvinside', 'paused', 'michael.smith@kelvinside.org', 'United Kingdom', 'Kelvinside Academy, independent, Glasgow', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: M Smith
Contact email: michael.smith@kelvinside.org
Services previously provided: UCAT
Years engaged: 2025
Last year worked together: 2025
Location / description: Kelvinside Academy, independent, Glasgow
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_kingham-hill', 'Kingham Hill', 'kingham-hill', 'paused', 's.kilmister@kinghamhill.org', 'United Kingdom', 'Kingham Hill School, independent boarding, Oxfordshire', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: S Kilminster
Contact email: s.kilmister@kinghamhill.org
Services previously provided: MM Int
Years engaged: 2025
Last year worked together: 2025
Location / description: Kingham Hill School, independent boarding, Oxfordshire
Reconnect status: Yes - 15/05 Followed up: 25/05
Notes: s.kilmister@kinghamhill.org the address couldn''t be found or is unable to receive email.'),
    ('ba_reconnect_kingsmead', 'Kingsmead', 'kingsmead', 'paused', 'hrees@kingsmead.org', 'United Kingdom', 'Kingsmead School, Somerset', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: H Rees
Contact email: hrees@kingsmead.org
Services previously provided: Interview
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Kingsmead School, Somerset
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_lancing-college', 'Lancing College', 'lancing-college', 'paused', 'jjb@lancing.org.uk', 'United Kingdom', 'Lancing College, independent boarding/day, West Sussex', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: J Bullen
Contact email: jjb@lancing.org.uk
Services previously provided: AL
Years engaged: 2024
Last year worked together: 2024
Location / description: Lancing College, independent boarding/day, West Sussex
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_leicester-high-school-for-girls', 'Leicester High School for Girls', 'leicester-high-school-for-girls', 'paused', 'm.ryman@leicesterhigh.co.uk', 'United Kingdom', 'Leicester High School for Girls, independent', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: M Ryman
Contact email: m.ryman@leicesterhigh.co.uk
Services previously provided: OM int, OXB, UCAT
Years engaged: 2024, 2025
Last year worked together: 2025
Location / description: Leicester High School for Girls, independent
Reconnect status: Yes - 15/05 Followed up: 25/05
Notes: Replied on June 1'),
    ('ba_reconnect_leyton', 'Leyton', 'leyton', 'paused', 'roma.patel@leyton.ac.uk', 'United Kingdom', 'Leyton Sixth Form College, London', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: R Patel
Contact email: roma.patel@leyton.ac.uk
Services previously provided: LNAT, UCAT
Years engaged: 2022-2023, 2025
Last year worked together: 2025
Location / description: Leyton Sixth Form College, London
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_liverpool-college', 'Liverpool College', 'liverpool-college', 'paused', 'sedoran@liverpoolcollege.org.uk', 'United Kingdom', 'Liverpool College, independent, Liverpool', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: S Doran
Contact email: sedoran@liverpoolcollege.org.uk
Email details (as recorded): Mrs. S. Doran <sedoran@liverpoolcollege.org.uk>
Services previously provided: UCAT
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Liverpool College, independent, Liverpool
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_mulberry', 'Mulberry', 'mulberry', 'paused', 'lgillott@mulberryschoolstrust.org', 'United Kingdom', 'Mulberry School for Girls / Mulberry Schools Trust, Tower Hamlets', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: L Gillott
Contact email: lgillott@mulberryschoolstrust.org
Other emails: amohamud@mulberryschoolstrust.org
Email details (as recorded): Lauren: lgillott@mulberryschoolstrust.org Amal (Finance officer): amohamud@mulberryschoolstrust.org
Services previously provided: Interview, MM Int, OM, OM Int, TMUA
Years engaged: 2022-2023, 2024, 2025
Last year worked together: 2025
Location / description: Mulberry School for Girls / Mulberry Schools Trust, Tower Hamlets
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_ncc-london', 'NCC London', 'ncc-london', 'paused', 'gursewa.harrad@ncclondon.ac.uk', 'United Kingdom', 'New City College, large FE college group with campuses in East London and Essex', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: G Harrad
Contact email: gursewa.harrad@ncclondon.ac.uk
Services previously provided: Books
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: New City College, large FE college group with campuses in East London and Essex
Reconnect status: Yes - 15/05 Followed up: 25/05
Notes: Gursewa.Harrad@ncclondon.ac.uk the address couldn''t be found or is unable to receive email.'),
    ('ba_reconnect_netherwood', 'Netherwood', 'netherwood', 'paused', 'emma-jane.ghataurhae@astreanetherwood.org', 'United Kingdom', 'Netherwood Academy, Barnsley (Astrea Academy Trust)', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: E-J Ghataurhae
Contact email: emma-jane.ghataurhae@astreanetherwood.org
Services previously provided: AL
Years engaged: 2022-2023, 2024
Last year worked together: 2024
Location / description: Netherwood Academy, Barnsley (Astrea Academy Trust)
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_north-liverpool-academy', 'North Liverpool Academy', 'north-liverpool-academy', 'paused', 'a.johnstonnla@northliverpoolacademy.co.uk', 'United Kingdom', 'North Liverpool Academy, secondary', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: A Johnston
Contact email: a.johnstonnla@northliverpoolacademy.co.uk
Services previously provided: Interview, OM INT, UCAT
Years engaged: 2022-2023, 2025
Last year worked together: 2025
Location / description: North Liverpool Academy, secondary
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_oxford-high', 'Oxford High', 'oxford-high', 'paused', 'c.heath@oxf.gdst.net', 'United Kingdom', 'Oxford High School GDST, independent girls, Oxford', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: C Heath
Contact email: c.heath@oxf.gdst.net
Services previously provided: Interview, LNAT, UCAT
Years engaged: 2022-2023, 2024
Last year worked together: 2024
Location / description: Oxford High School GDST, independent girls, Oxford
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_oxford-international-college', 'Oxford International College', 'oxford-international-college', 'paused', 'info@oxfordinternational.com', 'United Kingdom', 'Oxford International College, private sixth-form college, Oxford', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: OIC
Contact email: info@oxfordinternational.com
Services previously provided: High Value
Years engaged: 2022-2023, 2024
Last year worked together: 2024
Location / description: Oxford International College, private sixth-form college, Oxford
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_park-hall', 'Park Hall', 'park-hall', 'paused', 'icornell@parkhall.org', 'United Kingdom', 'Park Hall Academy, Castle Bromwich, Birmingham (Arden MAT)', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: I Cornell
Contact email: icornell@parkhall.org
Services previously provided: AL
Years engaged: 2024
Last year worked together: 2024
Location / description: Park Hall Academy, Castle Bromwich, Birmingham (Arden MAT)
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_phoenix-collegiate', 'Phoenix Collegiate', 'phoenix-collegiate', 'paused', 'luke.stevens@phoenix.sandwell.sch.uk', 'United Kingdom', 'Phoenix Collegiate, secondary academy, West Bromwich', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: L Stevens
Contact email: luke.stevens@phoenix.sandwell.sch.uk
Services previously provided: Interview
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Phoenix Collegiate, secondary academy, West Bromwich
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_pocklington', 'Pocklington', 'pocklington', 'paused', NULL, 'United Kingdom', 'Pocklington School, independent, East Yorkshire', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: G Jones
Services previously provided: Interview
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Pocklington School, independent, East Yorkshire
Notes: Can''t find email thread with the school and contact person'),
    ('ba_reconnect_royal-hospital-school', 'Royal Hospital School', 'royal-hospital-school', 'paused', 'hizod@royalhospitalschool.org', 'United Kingdom', 'Royal Hospital School, independent boarding, Suffolk', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: H Izod-Miller
Contact email: hizod@royalhospitalschool.org
Services previously provided: MMI , UCAT, UCAT , Vet Int
Years engaged: 2022-2023, 2025
Last year worked together: 2025
Location / description: Royal Hospital School, independent boarding, Suffolk
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_rugby', 'Rugby', 'rugby', 'paused', 'lw@rugbyschool.net', 'United Kingdom', 'Rugby School, independent boarding, Warwickshire', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: L Waweru
Contact email: lw@rugbyschool.net
Services previously provided: Interview
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Rugby School, independent boarding, Warwickshire
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_saltash', 'Saltash', 'saltash', 'paused', 'tward@saltashcloud.net', 'United Kingdom', 'Saltash Community School, Cornwall', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: T Ward
Contact email: tward@saltashcloud.net
Services previously provided: LNAT
Years engaged: 2024
Last year worked together: 2024
Location / description: Saltash Community School, Cornwall
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_seven-kings', 'Seven Kings', 'seven-kings', 'paused', 'j.macallan@sevenkings.school', 'United Kingdom', 'Seven Kings High School, Ilford', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: J Macallan
Contact email: j.macallan@sevenkings.school
Services previously provided: UCAT
Years engaged: 2024
Last year worked together: 2024
Location / description: Seven Kings High School, Ilford
Reconnect status: Yes - 15/05 Followed up: 25/05
Notes: j.macallan@sevenkings.school the address couldn''t be found or is unable to receive email.'),
    ('ba_reconnect_solihull-school', 'Solihull School', 'solihull-school', 'paused', 'fosters@solsch.org.uk', 'United Kingdom', 'Solihull School, independent, West Midlands', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: Rhian Chillcott
Contact email: fosters@solsch.org.uk
Email details (as recorded): Sian Foster: fosters@solsch.org.uk
Services previously provided: UCAT
Years engaged: 2024, 2025
Last year worked together: 2025
Location / description: Solihull School, independent, West Midlands
Reconnect status: Yes - 25/05
Notes: fosters@solsch.org.uk the address couldn''t be found or is unable to receive email.'),
    ('ba_reconnect_st-dunstans', 'St Dunstans', 'st-dunstans', 'paused', 'rredding@stdunstans.org.uk', 'United Kingdom', 'St Dunstan''s College, independent, Catford', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: R Redding
Contact email: rredding@stdunstans.org.uk
Services previously provided: OXB Workshop
Years engaged: 2025
Last year worked together: 2025
Location / description: St Dunstan''s College, independent, Catford
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_st-peter-s-school-surrey', 'St Peter''s School (Surrey)', 'st-peter-s-school-surrey', 'paused', 'znoonan@st-peters.surrey.sch.uk', 'United Kingdom', 'St Peter''s C of E School, Surrey', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: Z Noonan
Contact email: znoonan@st-peters.surrey.sch.uk
Services previously provided: AL, GCSE
Years engaged: 2024, 2025
Last year worked together: 2025
Location / description: St Peter''s C of E School, Surrey
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_stafford-grammar', 'Stafford Grammar', 'stafford-grammar', 'paused', 'c.anderson@staffordgrammar.co.uk', 'United Kingdom', 'Stafford Grammar School, independent', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: C Anderson
Contact email: c.anderson@staffordgrammar.co.uk
Services previously provided: UCAT
Years engaged: 2025
Last year worked together: 2025
Location / description: Stafford Grammar School, independent
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_swakeleys', 'Swakeleys', 'swakeleys', 'paused', 'ctooker@swakeleys.org.uk', 'United Kingdom', 'Swakeleys School for Girls, Hillingdon', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: C Tooker
Contact email: ctooker@swakeleys.org.uk
Services previously provided: UCAT
Years engaged: 2024, 2025
Last year worked together: 2025
Location / description: Swakeleys School for Girls, Hillingdon
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_tabor-academy', 'Tabor Academy', 'tabor-academy', 'paused', 'hughesst@taboracademy.co.uk', 'United Kingdom', 'Tabor Academy, Braintree, Essex (Loxford Trust)', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: S Hughes
Contact email: hughesst@taboracademy.co.uk
Services previously provided: AL
Years engaged: 2024
Last year worked together: 2024
Location / description: Tabor Academy, Braintree, Essex (Loxford Trust)
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_teignmouth', 'Teignmouth', 'teignmouth', 'paused', 'samantha.atkinson@teignmouthschool.co.uk', 'United Kingdom', 'Teignmouth Community School, Devon', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: S Atkinson
Contact email: samantha.atkinson@teignmouthschool.co.uk
Services previously provided: AL
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Teignmouth Community School, Devon
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_townley-grammar', 'Townley Grammar', 'townley-grammar', 'paused', 'sperfect@townleygrammar.org.uk', 'United Kingdom', 'Townley Grammar School, Bexley', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: S Perfect
Contact email: sperfect@townleygrammar.org.uk
Services previously provided: Interview
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Townley Grammar School, Bexley
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_truro-high', 'Truro High', 'truro-high', 'paused', 'pmurray@trurohigh.co.uk', 'United Kingdom', 'Truro High School for Girls, independent, Cornwall', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: P Murray
Contact email: pmurray@trurohigh.co.uk
Services previously provided: UCAT
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Truro High School for Girls, independent, Cornwall
Reconnect status: Last messaged: 14/05 Followed up: 25/05 3rd follow up: 02/06'),
    ('ba_reconnect_west-buckland', 'West Buckland', 'west-buckland', 'active', 'mtb@westbuckland.com', 'United Kingdom', 'West Buckland School, independent, Devon', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: M Brimson
Contact email: mtb@westbuckland.com
Services previously provided: Interview, MM Int, UCAT
Years engaged: 2022-2023, 2024, 2025
Last year worked together: 2025
Location / description: West Buckland School, independent, Devon
Reconnect status: Yes
Notes: Already made deal for 2026'),
    ('ba_reconnect_wardle-academy', 'Wardle Academy', 'wardle-academy', 'paused', 'cuncarrs@wardleacademy.co.uk', 'United Kingdom', 'Wardle Academy, Rochdale, state secondary 11-16 only (no sixth form)', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Key contact: S Cuncarrs
Contact email: cuncarrs@wardleacademy.co.uk
Other emails: finance@wardleacademy.co.uk
Email details (as recorded): finance@wardleacademy.co.uk Sophie Carrey: cuncarrs@wardleacademy.co.uk
Services previously provided: AL
Years engaged: 2024
Last year worked together: 2024
Location / description: Wardle Academy, Rochdale, state secondary 11-16 only (no sixth form)
Reconnect status: Yes - 25/05
Source type flag: School (note)'),
    ('ba_reconnect_trinity-college', 'Trinity College', 'trinity-college', 'paused', NULL, NULL, 'Ambiguous: could be Trinity School Croydon, Trinity Sixth Form Halifax, Trinity High, or Trinity Cumbria', 'Previous Study Mind partner school — re-engaging (Reconnect 2026 outreach list).

Services previously provided: AL
Years engaged: 2022-2023
Last year worked together: 2022-2023
Location / description: Ambiguous: could be Trinity School Croydon, Trinity Sixth Form Halifax, Trinity High, or Trinity Cumbria
Notes: Can''t find email thread with the school and contact person
Source type flag: Unclear')
) AS i("id", "name", "slug", "status", "contactEmail", "country", "description", "notes")
WHERE NOT EXISTS (
  SELECT 1
  FROM "BusinessAccount" e
  WHERE e."kind" = 'school'
    AND (
      -- 1. exact match on alphanumerics only (punctuation/spacing-insensitive)
      regexp_replace(lower(e."name"), '[^a-z0-9]', '', 'g')
        = regexp_replace(lower(i."name"), '[^a-z0-9]', '', 'g')
      -- 2. same slug (however the existing account was named)
      OR e."slug" = i."slug"
      -- 3. whole-word leading prefix, either direction (long/short forms).
      --    Compare word-tokenised names; the trailing ' %' forces the match to
      --    land on a word boundary so "leytonstone" never matches "leyton".
      OR trim(regexp_replace(lower(e."name"), '[^a-z0-9]+', ' ', 'g'))
           LIKE trim(regexp_replace(lower(i."name"), '[^a-z0-9]+', ' ', 'g')) || ' %'
      OR trim(regexp_replace(lower(i."name"), '[^a-z0-9]+', ' ', 'g'))
           LIKE trim(regexp_replace(lower(e."name"), '[^a-z0-9]+', ' ', 'g')) || ' %'
    )
)
ON CONFLICT DO NOTHING;

-- A shared label so the whole reconnect batch is filterable on /accounts.
INSERT INTO "AccountLabel" ("id", "name", "color", "description", "sortOrder", "createdAt", "updatedAt")
VALUES (
  'alabel_reconnect_2026',
  'Reconnect 2026',
  '#2563EB',
  'Past partner schools re-engaged from the Study Mind Reconnect list (2026).',
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT DO NOTHING;

-- Tag the accounts we just inserted (matched by our fixed ids, so pre-existing
-- schools that were skipped above are left untouched).
INSERT INTO "BusinessAccountLabel" ("accountId", "labelId", "createdAt")
SELECT ba."id", 'alabel_reconnect_2026', CURRENT_TIMESTAMP
FROM "BusinessAccount" ba
WHERE ba."id" IN (
    'ba_reconnect_acs-international',
    'ba_reconnect_archbishop-holgate',
    'ba_reconnect_aston-manor',
    'ba_reconnect_aylward-academy',
    'ba_reconnect_bisr',
    'ba_reconnect_barclay',
    'ba_reconnect_beal-high',
    'ba_reconnect_bedford-school',
    'ba_reconnect_belle-vue',
    'ba_reconnect_berkhamsted',
    'ba_reconnect_bonn-international',
    'ba_reconnect_brentwood',
    'ba_reconnect_camborne-science-and-international-academy',
    'ba_reconnect_cannock-chase',
    'ba_reconnect_canterbury-academy',
    'ba_reconnect_chigwell',
    'ba_reconnect_city-academy',
    'ba_reconnect_clevedon-school',
    'ba_reconnect_corby-technical',
    'ba_reconnect_djanogly',
    'ba_reconnect_drayton-manor',
    'ba_reconnect_eastbourne-college',
    'ba_reconnect_eton-college',
    'ba_reconnect_ferndown',
    'ba_reconnect_greater-peterborough-utc',
    'ba_reconnect_gunnersbury',
    'ba_reconnect_harris-rainham',
    'ba_reconnect_henry-cort',
    'ba_reconnect_houston-british-international',
    'ba_reconnect_hymers',
    'ba_reconnect_isf-waterloo',
    'ba_reconnect_immanuel-college',
    'ba_reconnect_institute-rosenberg',
    'ba_reconnect_john-frost',
    'ba_reconnect_kyuem',
    'ba_reconnect_kelvinside',
    'ba_reconnect_kingham-hill',
    'ba_reconnect_kingsmead',
    'ba_reconnect_lancing-college',
    'ba_reconnect_leicester-high-school-for-girls',
    'ba_reconnect_leyton',
    'ba_reconnect_liverpool-college',
    'ba_reconnect_mulberry',
    'ba_reconnect_ncc-london',
    'ba_reconnect_netherwood',
    'ba_reconnect_north-liverpool-academy',
    'ba_reconnect_oxford-high',
    'ba_reconnect_oxford-international-college',
    'ba_reconnect_park-hall',
    'ba_reconnect_phoenix-collegiate',
    'ba_reconnect_pocklington',
    'ba_reconnect_royal-hospital-school',
    'ba_reconnect_rugby',
    'ba_reconnect_saltash',
    'ba_reconnect_seven-kings',
    'ba_reconnect_solihull-school',
    'ba_reconnect_st-dunstans',
    'ba_reconnect_st-peter-s-school-surrey',
    'ba_reconnect_stafford-grammar',
    'ba_reconnect_swakeleys',
    'ba_reconnect_tabor-academy',
    'ba_reconnect_teignmouth',
    'ba_reconnect_townley-grammar',
    'ba_reconnect_truro-high',
    'ba_reconnect_west-buckland',
    'ba_reconnect_wardle-academy',
    'ba_reconnect_trinity-college'
  )
ON CONFLICT DO NOTHING;
