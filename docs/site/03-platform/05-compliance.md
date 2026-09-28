---
title: Compliance
sidebar_position: 5
description: Sentrello holds no certifications and claims none. What self-hosting does is put the controls in your hands.
tags: [platform, compliance, gdpr]
---

# Compliance

## What this page is not

Sentrello holds no compliance certification, and this page claims none. What
follows is the posture self-hosting gives the business running the instance.
The controls that matter end up in your hands, which is where an assessor
expects to find them.

Compliance is a property of the business being audited, not of its software.
What software can do is give you the tools and the evidence.

## Data residency is a decision, not a feature

The database runs on a server you choose: your own building, or any host, in
whatever jurisdiction your obligations require. Business data stays on that
server. A free instance contacts nobody. A paid instance sends one licence
check an hour, carrying a key and an instance id; see
[Security](/platform/security).

There is one exception, and it is worth stating before anybody else finds it.
The SEO module can look keywords up through SEO Cloud instead of through a
provider account of your own. Chosen, that makes Sentrello a processor for the
domains and keywords being researched, and nothing else. Every other module
runs with nothing leaving the instance.

## Retention and access belong to you

Backups, exports and deletion happen on your schedule, with direct `psql`
access to the database itself. Access control is built in: role policies,
organisation-scoped queries, two-factor authentication, and a log of account
events.

## The controls, framework by framework

**GDPR and CCPA.** A subject access request is answered from one screen, across
every installed module at once: export what is held, erase what may lawfully be
erased, and get a written record of both, including what was kept and why.
Modules contribute to that answer through the SDK rather than being chased
individually, so a module installed next year is included without anybody
remembering to add it. The CCPA "do not sell or share" opt-out is recorded with
the date it was received and carried into every contact export.

**HIPAA.** An optional safeguards switch in Settings turns on automatic
sign-out, mandatory two-factor authentication, and a log of every read of a
patient's record. The screen also lists what stays your own responsibility:
risk assessment, training, and business associate agreements.

**PCI DSS.** Card details never touch the server. Payment goes straight to the
processor, which keeps you on the shortest self-assessment there is, SAQ A.

**SOC 2.** An exportable evidence pack: the access list, every change to it,
second-factor coverage, and the personal-data inventory. Whatever it cannot
evidence is named rather than implied.

## The source is auditable

Anything asserted about how the free core handles data can be verified
directly, because the code is public under the AGPLv3. When a customer, an
accountant or a regulator asks where the data is and who can reach it, the
answer is short: on your own server, reachable by the accounts you created.
