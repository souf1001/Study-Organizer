# E2E Test Infra: Study Organizer Calendar & University Integrations

## Test Philosophy
- **Opaque-box & Requirement-driven**: Derived strictly from `ORIGINAL_REQUEST.md` and user-facing specifications, independent of internal implementations.
- **Methodology**: Systematic 4-Tier Framework (Category-Partition, Boundary Value Analysis, Pairwise Combinatorial, and Real-World Workload Testing).

## Feature Inventory & Tier Breakdown
| # | Feature | Requirement Source | Tier 1 (Coverage) | Tier 2 (Boundary) | Tier 3 (Pairwise) |
|---|---------|-------------------|:-----------------:|:-----------------:|:-----------------:|
| 1 | UTF-16LE / BE / UTF-8 BOM Decoding | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 2 | `exercise` EventKind Support | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 3 | Expanded Academic Classification | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 4 | Intelligent Module Recognition | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 5 | Module Auto-Creation for Active Semester | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 6 | Robust Duplicate & Snapshot Handling | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ |
| 7 | CalendarView Direct ICS Upload Button | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 8 | CalendarView Drag-and-Drop Dropzone | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 9 | Calendar Event Refresh & Reactive UI Feedback | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 10 | Calendar-Level Subscription Management | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ |
| 11 | TUCaN Guided Session / Export Wizard | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 12 | University WebCal & Direct Feed URL Sync | ORIGINAL_REQUEST §R3, §R4 | 5 | 5 | ✓ |
| 13 | Integration Settings UI for TUCaN & Feeds | ORIGINAL_REQUEST §R3, §R4 | 5 | 5 | ✓ |
| 14 | Non-Blocking Network & Error Handling | ORIGINAL_REQUEST §R3, §R4 | 5 | 5 | ✓ |
| 15 | Multi-Event Recurrence (RRULE) Expansion | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |

## Test Architecture
- **Runner**: Vitest v5.0.2 in Node / happy-dom environment (`npm test` / `npx vitest run tests/`).
- **Test Locations**:
  - `tests/ics.test.ts`: Unit tests for decoding, parsing, EventKind classification, and module matching.
  - `tests/calendar-e2e.test.ts`: Integration and E2E simulation tests for file import, drag-and-drop ingestion, duplicate handling, subscription lifecycle, and TUCaN wizard flow.
- **Pass/Fail Semantics**: All tests must execute cleanly with exit code 0, 0 unhandled promise rejections, 0 memory leaks.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Semester Start: Fresh TUCaN UTF-16LE timetable import with automated module creation and event classification | F1, F2, F3, F4, F5, F6, F9, F15 | High |
| 2 | Drag & Drop Multi-file update: Dropping replacement ICS files onto CalendarView with duplicate detection | F6, F7, F8, F9, F10 | Medium |
| 3 | Hybrid University Feeds: Simultaneous Moodle webcal feed, manual TUCaN import, and regular subscription sync | F6, F10, F12, F13, F14, F15 | High |
| 4 | Offline / Network Failure Resilience: Invalid or unreachable feed URLs handled gracefully without blocking UI | F12, F13, F14 | Medium |
| 5 | Cross-Semester Transition: Importing events spanning semester boundaries with module code mapping | F3, F4, F5, F9, F15 | High |
| 6 | Event Modification & Recurrence Exception: Overriding individual dates of recurring lectures | F2, F3, F6, F9, F15 | High |
| 7 | TUCaN Wizard Assisted Session: Initiating wizard, intercepting download, and auto-importing into calendar | F1, F6, F9, F11, F13 | High |
| 8 | Subscription Removal & Cascade Cleanup: Unsubscribing removes all associated calendar entries cleanly | F6, F10, F13 | Medium |

## Coverage Thresholds
- **Tier 1 (Feature Coverage)**: ≥ 75 test cases (5 per feature × 15 features)
- **Tier 2 (Boundary & Corner Cases)**: ≥ 75 test cases (empty files, malformed ICS, corrupted BOMs, special characters, max dates, zero-duration events)
- **Tier 3 (Cross-Feature Combinations)**: ≥ 15 pairwise interaction test cases
- **Tier 4 (Real-World Scenarios)**: ≥ 8 holistic end-to-end workload scenarios
- **Total Suite**: ≥ 173 test cases
