#!/usr/bin/env -S npx tsx
/**
 * Atlas Markdown Validator
 *
 * Standalone validator for Atlas Markdown files.
 *
 * Validations performed:
 * 1. Title Line Format - Validates exact pattern: `# {DocNo} - {Name} [{Type}]  <!-- UUID: {uuid} -->`
 * 2. Document Types - Ensures document type is one of the 12 valid Atlas document types
 * 3. Heading Level Cap - Ensures heading levels never exceed 6 (######)
 * 4. Heading Hierarchy - Validates heading levels match document number-based semantic depth
 * 5. Blank Lines - Validates required blank lines after titles and around extra fields
 * 6. Extra Fields - Validates format, order, and presence of required fields for:
 *    - Type Specification (6 fields)
 *    - Scenario (3 fields)
 *    - Scenario Variation (3 fields)
 *    - Needed Research (1 field)
 * 7. Document Numbering - Validates patterns for all 12 document types (e.g., A.1, NR-1, .0.3.1)
 * 8. Nesting Rules - Ensures valid parent-child type combinations based on document numbers
 * 9. UUID Validation - Checks format (UUID v4), uniqueness, and warns about empty UUIDs
 * 10. Document Number Uniqueness - Ensures each document number is used only once
 *
 * Usage:
 *   npx tsx validate-atlas-markdown.ts path/to/atlas.md
 *   or
 *   ./validate-atlas-markdown.ts path/to/atlas.md (after chmod +x)
 *
 * Exit codes:
 *   0 - No errors (warnings OK)
 *   1 - Errors found
 */
import * as fs from 'fs';
import * as path from 'path';

// GitHub Actions support (optional)
type ActionsCore = typeof import('@actions/core') | null;
let core: ActionsCore = null;
let isGitHubActions = false;

// Initialize GitHub Actions support if available
function initGitHubActions(): void {
  if (process.env.GITHUB_ACTIONS === 'true') {
    try {
      // Use dynamic import in an async context
      import('@actions/core')
        .then((module) => {
          core = module;
          isGitHubActions = true;
        })
        .catch(() => {
          // @actions/core not available, continue without it
        });
    } catch {
      // @actions/core not available, continue without it
    }
  }
}

initGitHubActions();

// ============================================================================
// Types
// ============================================================================

interface ValidationIssue {
  line: number;
  severity: 'error' | 'warning';
  message: string;
  found?: string;
  expected?: string;
  reason?: string;
  example?: string;
  action: string;
}

interface Document {
  line: number;
  level: number;
  docNo: string;
  name: string;
  type: AtlasDocumentType;
  uuid: string;
  rawLine: string;
}

// ============================================================================
// Constants
// ============================================================================

const DOCUMENT_TYPES = [
  'Scope',
  'Article',
  'Section',
  'Core',
  'Type Specification',
  'Active Data Controller',
  'Annotation',
  'Action Tenet',
  'Scenario',
  'Scenario Variation',
  'Active Data',
  'Needed Research',
] as const;

type AtlasDocumentType = (typeof DOCUMENT_TYPES)[number];

const EXTRA_FIELDS: Partial<Record<AtlasDocumentType, string[]>> = {
  'Type Specification': [
    'Components',
    'Doc Identifier Rules',
    'Additional Logic',
    'Type Category',
    'Type Name',
    'Type Overview',
  ],
  Scenario: ['Description', 'Finding', 'Additional Guidance'],
  'Scenario Variation': ['Description', 'Finding', 'Additional Guidance'],
  'Needed Research': ['Content'],
};

const TITLE_REGEX = /^(#+)\s+([^\s]+)\s+-\s+(.+?)\s+\[(.+?)\]\s{2}<!--\s*UUID:\s*([a-f0-9-]*)\s*-->$/i;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTRA_FIELD_LABEL_REGEX = /^\*\*(.+?)\*\*:\s*$/;

// Temporary suppression list for known duplicate UUIDs that will be fixed soon
const SUPPRESSED_DUPLICATE_UUIDS = new Set([
  'e4e7dab8-5e4d-41ad-b1e0-ba3cb9a6f02a', // Temporary: duplicate at lines 1727 and 2207
]);

// Allowed parent-child type combinations
const ALLOWED_NESTING: Record<AtlasDocumentType, AtlasDocumentType[]> = {
  Scope: ['Article', 'Needed Research'],
  Article: ['Section', 'Annotation', 'Needed Research'],
  Section: [
    'Section',
    'Core',
    'Type Specification',
    'Active Data Controller',
    'Annotation',
    'Action Tenet',
    'Needed Research',
  ],
  Core: ['Core', 'Type Specification', 'Active Data Controller', 'Annotation', 'Action Tenet', 'Needed Research'],
  'Type Specification': ['Annotation', 'Action Tenet', 'Needed Research'],
  'Active Data Controller': ['Active Data', 'Annotation', 'Action Tenet', 'Needed Research'],
  Annotation: ['Needed Research'],
  'Action Tenet': ['Scenario', 'Needed Research'],
  Scenario: ['Scenario Variation', 'Needed Research'],
  'Scenario Variation': ['Needed Research'],
  'Active Data': ['Needed Research'],
  'Needed Research': [],
};

// ============================================================================
// Helper Functions for Document Number-Based Depth Calculation
// ============================================================================

/**
 * Calculate the semantic depth of a document based on its document number and type.
 * This matches the logic in atlas-markdown-depth-utils.ts but is duplicated here
 * to keep the validator standalone.
 */
function calculateSemanticDepth(docNo: string, type: AtlasDocumentType): number | null {
  if (type === 'Needed Research') {
    return null; // Context-dependent
  }

  // For supporting documents with special patterns, calculate based on target document
  if (['Annotation', 'Action Tenet', 'Scenario', 'Scenario Variation', 'Active Data'].includes(type)) {
    const parentDocNo = findParentDocNumber(docNo, type);
    if (parentDocNo && parentDocNo !== docNo) {
      const parentType = inferDocumentType(parentDocNo);
      const parentDepth = calculateSemanticDepth(parentDocNo, parentType);
      return parentDepth !== null ? parentDepth + 1 : null;
    }
  }

  // For regular documents, count segments
  const segments = docNo.split('.');
  return segments.length - 1;
}

/**
 * Find the parent document number for a given document.
 */
function findParentDocNumber(docNo: string, type: AtlasDocumentType): string | null {
  if (type === 'Needed Research') return null;

  if (type === 'Scenario Variation') {
    const match = docNo.match(/^(.+)\.var\d+$/);
    return match ? match[1] : null;
  }

  if (type === 'Annotation') {
    const match = docNo.match(/^(.+)\.0\.3\.\d+$/);
    return match ? match[1] : null;
  }

  if (type === 'Action Tenet') {
    const match = docNo.match(/^(.+)\.0\.4\.\d+$/);
    return match ? match[1] : null;
  }

  if (type === 'Scenario') {
    const match = docNo.match(/^(.+)\.1\.\d+$/);
    return match ? match[1] : null;
  }

  if (type === 'Active Data') {
    const match = docNo.match(/^(.+)\.0\.6\.\d+$/);
    return match ? match[1] : null;
  }

  const segments = docNo.split('.');
  if (segments.length <= 2) return null;

  return segments.slice(0, -1).join('.');
}

/**
 * Infer the document type from a document number (heuristic).
 */
function inferDocumentType(docNo: string): AtlasDocumentType {
  if (docNo.startsWith('NR-')) return 'Needed Research';

  // Check for special patterns (order matters!)
  if (docNo.match(/\.var\d+$/)) return 'Scenario Variation';
  if (docNo.match(/\.0\.3\.\d+$/)) return 'Annotation';
  if (docNo.match(/\.0\.6\.\d+$/)) return 'Active Data';

  // Scenarios: <target>.0.4.<tenet-num>.1.<scenario-num>
  // Must check for .0.4. before .1. to avoid false positives with Core documents like A.0.1.2.1.1
  if (docNo.match(/\.0\.4\.\d+\.1\.\d+$/)) return 'Scenario';

  // Tenets: <target>.0.4.<tenet-num> (but NOT followed by .1.X which would be Scenario)
  if (docNo.match(/\.0\.4\.\d+$/)) return 'Action Tenet';

  const segments = docNo.split('.');
  const depth = segments.length - 1;

  switch (depth) {
    case 1:
      return 'Scope';
    case 2:
      return 'Article';
    case 3:
      return 'Section';
    default:
      return 'Core';
  }
}

/**
 * Calculate the expected heading level (1-6) for a document.
 */
function calculateExpectedHeadingLevel(docNo: string, type: AtlasDocumentType): number {
  // Needed Research should not use this function directly
  // It's handled in validateHierarchy by finding the parent document

  const semanticDepth = calculateSemanticDepth(docNo, type);
  if (semanticDepth === null) return 6; // Fallback

  return Math.min(6, Math.max(1, semanticDepth));
}

// ============================================================================
// Validation Functions
// ============================================================================

function parseTitleLine(line: string, lineNum: number): { doc: Document | null; issue: ValidationIssue | null } {
  const match = line.match(TITLE_REGEX);

  if (!match) {
    // Check if it looks like a title but is malformed
    if (line.match(/^#+\s+.+\[.+\]/)) {
      return {
        doc: null,
        issue: {
          line: lineNum,
          severity: 'error',
          message: '📝 Invalid title format',
          found: line,
          expected: '# {DocNo} - {Name} [{Type}]  <!-- UUID: {uuid} -->',
          action: 'Ensure exactly 2 spaces before <!-- and proper formatting',
        },
      };
    }
    return {
      doc: null,
      issue: {
        line: lineNum,
        severity: 'error',
        message: '📝 Invalid title format',
        found: line,
        expected: '# {DocNo} - {Name} [{Type}]  <!-- UUID: {uuid} -->',
        action: 'Ensure proper title format with all required components',
      },
    };
  }

  const [, hashes, docNo, name, type, uuid] = match;
  const level = hashes.length;

  const doc: Document = {
    line: lineNum,
    level,
    docNo,
    name,
    type: type as AtlasDocumentType,
    uuid,
    rawLine: line,
  };

  // Validate document type
  if (!(DOCUMENT_TYPES as readonly string[]).includes(type as AtlasDocumentType)) {
    return {
      doc, // Still return doc for UUID validation
      issue: {
        line: lineNum,
        severity: 'error',
        message: `🏷️  Invalid document type '${type}'`,
        found: type,
        expected: `One of: ${DOCUMENT_TYPES.join(', ')}`,
        action: 'Use a valid document type',
      },
    };
  }

  return { doc, issue: null };
}

function validateHierarchy(docs: Document[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];

    // Check 1: Heading level must not exceed 6
    if (doc.level > 6) {
      issues.push({
        line: doc.line,
        severity: 'error',
        message: `🪜 Heading level exceeds maximum of 6`,
        found: `${'#'.repeat(doc.level)} (${doc.level} hashtags)`,
        expected: `Maximum 6 hashtags (######)`,
        reason: 'Markdown viewers do not support more than 6 heading levels',
        action: `Use ###### (6 hashtags) for documents at depth > 6`,
      });
    }

    // Check 2: Heading level should match semantic depth (capped at 6)
    // For Needed Research, find the parent by looking backwards at shallower heading levels
    let expectedLevel: number;
    if (doc.type === 'Needed Research') {
      // Find parent document (first document with lower heading level going backwards)
      let parentDoc: Document | undefined;
      for (let j = i - 1; j >= 0; j--) {
        if (docs[j].level < doc.level) {
          parentDoc = docs[j];
          break;
        }
      }

      if (parentDoc) {
        const parentLevel = calculateExpectedHeadingLevel(parentDoc.docNo, parentDoc.type);
        expectedLevel = Math.min(6, parentLevel + 1);
      } else {
        expectedLevel = 6; // Fallback for root-level NR (shouldn't happen)
      }
    } else {
      expectedLevel = calculateExpectedHeadingLevel(doc.docNo, doc.type);
    }

    if (doc.level !== expectedLevel) {
      const semanticDepth = calculateSemanticDepth(doc.docNo, doc.type);
      const depthInfo = semanticDepth !== null ? ` (semantic depth: ${semanticDepth})` : '';

      issues.push({
        line: doc.line,
        severity: 'error',
        message: `🪜 Heading level mismatch`,
        found: `${'#'.repeat(doc.level)} ${doc.docNo}${depthInfo}`,
        expected: `${'#'.repeat(expectedLevel)} ${doc.docNo} (expected ${expectedLevel} hashtags based on document number)`,
        reason: `Document number structure indicates semantic depth${depthInfo}, heading level should match (capped at 6)`,
        action: `Change to ${'#'.repeat(expectedLevel)} (${expectedLevel} hashtags)`,
      });
    }

    // Check 3: Parent-child relationship based on document numbers
    if (i > 0 && doc.type !== 'Needed Research') {
      const parentDocNo = findParentDocNumber(doc.docNo, doc.type);
      if (parentDocNo) {
        // Find the parent in previous documents
        let parentFound = false;
        for (let j = i - 1; j >= 0; j--) {
          if (docs[j].docNo === parentDocNo) {
            parentFound = true;
            break;
          }
        }

        if (!parentFound) {
          issues.push({
            line: doc.line,
            severity: 'error',
            message: `🌳 Missing parent document`,
            found: `Document ${doc.docNo} expects parent ${parentDocNo}`,
            expected: `Parent document ${parentDocNo} should appear before this document`,
            action: `Add missing parent document or fix document number`,
          });
        }
      }
    }
  }

  return issues;
}

function validateBlankLines(lines: string[], docs: Document[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const doc of docs) {
    const idx = doc.line - 1; // Convert to 0-based

    // Check blank line after title (always required, even before next document)
    if (idx + 1 < lines.length && lines[idx + 1].trim() !== '') {
      issues.push({
        line: doc.line + 1,
        severity: 'error',
        message: '📄 Missing blank line after title',
        action: 'Add a blank line after the title line',
      });
    }

    // Check for too many blank lines after title (should be exactly one)
    if (idx + 2 < lines.length && lines[idx + 1].trim() === '' && lines[idx + 2].trim() === '') {
      issues.push({
        line: doc.line + 2,
        severity: 'error',
        message: '📄 Too many blank lines after title',
        found: 'Multiple consecutive blank lines',
        expected: 'Exactly one blank line after title',
        action: 'Remove extra blank lines after the title line',
      });
    }
  }

  return issues;
}

function validateExtraFields(lines: string[], docs: Document[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Pre-compute document boundaries for performance
  const docBoundaries = new Map<number, number>();
  for (let i = 0; i < docs.length; i++) {
    const startIdx = docs[i].line - 1;
    const nextDocIdx = i + 1 < docs.length ? docs[i + 1].line - 1 : lines.length;
    docBoundaries.set(startIdx, nextDocIdx);
  }

  for (const doc of docs) {
    const requiredFields = EXTRA_FIELDS[doc.type];
    if (!requiredFields) continue;

    const docStartIdx = doc.line - 1;
    const nextDocIdx = docBoundaries.get(docStartIdx) || lines.length;

    const docLines = lines.slice(docStartIdx + 1, nextDocIdx);
    const foundFields: string[] = [];

    for (let i = 0; i < docLines.length; i++) {
      const line = docLines[i];
      const match = line.match(EXTRA_FIELD_LABEL_REGEX);

      if (match) {
        const fieldName = match[1];
        foundFields.push(fieldName);

        // Check if field is in required list
        if (!requiredFields.includes(fieldName)) {
          issues.push({
            line: docStartIdx + i + 2,
            severity: 'error',
            message: `➕ Unexpected extra field '${fieldName}' for document type '${doc.type}'`,
            expected: `Valid fields: ${requiredFields.join(', ')}`,
            action: `Remove this field or check if document type is correct`,
          });
        }

        // Check blank line after label
        if (i + 1 < docLines.length && docLines[i + 1].trim() !== '') {
          issues.push({
            line: docStartIdx + i + 3,
            severity: 'error',
            message: `📄 Extra field '${fieldName}' missing blank line after label`,
            found: `**${fieldName}**:\n${docLines[i + 1]}`,
            expected: `**${fieldName}**:\n\n${docLines[i + 1]}`,
            action: 'Add a blank line after the label line',
          });
        }
      }
    }

    // Check field order
    const expectedOrder = requiredFields.filter((f) => foundFields.includes(f));
    const actualOrder = foundFields.filter((f) => requiredFields.includes(f));

    if (JSON.stringify(expectedOrder) !== JSON.stringify(actualOrder)) {
      issues.push({
        line: doc.line,
        severity: 'error',
        message: `🔢 Extra fields in wrong order for '${doc.type}'`,
        found: `Found: ${actualOrder.join(', ')}`,
        expected: `Expected: ${requiredFields.join(', ')}`,
        action: 'Reorder extra fields to match the required order',
      });
    }

    // Check all required fields present
    for (const field of requiredFields) {
      if (!foundFields.includes(field)) {
        issues.push({
          line: doc.line,
          severity: 'error',
          message: `❌ Missing required extra field '${field}' for document type '${doc.type}'`,
          expected: `All fields: ${requiredFields.join(', ')}`,
          action: `Add the missing '${field}' field`,
        });
      }
    }
  }

  return issues;
}

function validateDocumentNumber(doc: Document): ValidationIssue | null {
  const { docNo, type } = doc;

  // Needed Research has special format
  if (type === 'Needed Research') {
    if (!docNo.match(/^NR-\d+$/)) {
      return {
        line: doc.line,
        severity: 'error',
        message: `🔢 Invalid Needed Research document number '${docNo}'`,
        expected: 'NR-{N} where N is a positive integer',
        example: 'NR-1, NR-5, NR-10',
        action: 'Use format NR-{N} for Needed Research documents',
      };
    }
    return null;
  }

  // All others should start with A.
  if (!docNo.startsWith('A.')) {
    return {
      line: doc.line,
      severity: 'error',
      message: `🔢 Document number '${docNo}' must start with 'A.'`,
      example: 'A.1, A.1.1, A.1.1.1',
      action: 'Ensure document number starts with A.',
    };
  }

  // Core, Type Specification, Active Data Controller cannot have .0. in number (except A.0 at start)
  if (['Core', 'Type Specification', 'Active Data Controller'].includes(type)) {
    // Match .0. but not at position after A (A.0 is valid for Scope inheritance)
    if (docNo.match(/(?<!^A)\.0\./)) {
      return {
        line: doc.line,
        severity: 'error',
        message: `🔢 Document number '${docNo}' invalid for document type '${type}'`,
        reason: `${type} documents cannot contain '.0.' in their document numbers (except inherited A.0)`,
        example: 'A.1.1.1, A.1.1.2.1, A.1.1.2.1.1, A.0.1.1.1',
        action: "Remove the '.0' segment or change document type to appropriate supporting document",
      };
    }
  }

  // Supporting documents should have special patterns
  if (type === 'Annotation' && !docNo.match(/\.0\.3\.\d+$/)) {
    return {
      line: doc.line,
      severity: 'error',
      message: `🔢 Invalid Annotation document number '${docNo}'`,
      expected: '{Target}.0.3.{N}',
      example: 'A.1.12.1.2.0.3.1',
      action: 'Use pattern {Target}.0.3.{N} for Annotations',
    };
  }

  if (type === 'Action Tenet' && !docNo.match(/\.0\.4\.\d+$/)) {
    return {
      line: doc.line,
      severity: 'error',
      message: `🔢 Invalid Action Tenet document number '${docNo}'`,
      expected: '{Target}.0.4.{N}',
      example: 'A.1.4.5.0.4.1',
      action: 'Use pattern {Target}.0.4.{N} for Action Tenets',
    };
  }

  if (type === 'Scenario' && !docNo.match(/\.1\.\d+$/)) {
    return {
      line: doc.line,
      severity: 'error',
      message: `🔢 Invalid Scenario document number '${docNo}'`,
      expected: '{Tenet}.1.{N}',
      example: 'A.1.4.5.0.4.1.1.1',
      action: 'Use pattern {Tenet}.1.{N} for Scenarios',
    };
  }

  if (type === 'Scenario Variation' && !docNo.match(/\.var\d+$/)) {
    return {
      line: doc.line,
      severity: 'error',
      message: `🔢 Invalid Scenario Variation document number '${docNo}'`,
      expected: '{Scenario}.var{N}',
      example: 'A.1.4.5.0.4.1.1.1.var1',
      action: 'Use pattern {Scenario}.var{N} for Scenario Variations',
    };
  }

  if (type === 'Active Data' && !docNo.match(/\.0\.6\.\d+$/)) {
    return {
      line: doc.line,
      severity: 'error',
      message: `🔢 Invalid Active Data document number '${docNo}'`,
      expected: '{Controller}.0.6.{N}',
      example: 'A.1.1.3.1.0.6.1',
      action: 'Use pattern {Controller}.0.6.{N} for Active Data',
    };
  }

  return null;
}

function validateNesting(docs: Document[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (let i = 1; i < docs.length; i++) {
    const child = docs[i];

    // Needed Research can nest anywhere
    if (child.type === 'Needed Research') continue;

    // Find parent based on document number
    const parentDocNo = findParentDocNumber(child.docNo, child.type);
    if (!parentDocNo) continue; // Root-level document

    // Find the parent document in the list
    let parent: Document | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (docs[j].docNo === parentDocNo) {
        parent = docs[j];
        break;
      }
    }

    if (!parent) {
      // Parent not found - this is already reported by validateHierarchy
      continue;
    }

    // Check if parent-child combination is allowed
    const allowedChildren = ALLOWED_NESTING[parent.type as AtlasDocumentType] || [];
    if (!allowedChildren.includes(child.type)) {
      issues.push({
        line: child.line,
        severity: 'error',
        message: `🌳 Invalid nesting: '${child.type}' cannot be nested under '${parent.type}'`,
        found: `Parent: ${parent.docNo} - ${parent.name} [${parent.type}] (line ${parent.line})\nChild:  ${child.docNo} - ${child.name} [${child.type}] (line ${child.line})`,
        expected: `${parent.type} can only contain: ${allowedChildren.join(', ') || 'no children'}`,
        action: `Move this document or change its type`,
      });
    }
  }

  return issues;
}

function validateDocumentNumberUniqueness(docs: Document[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const docNoMap = new Map<string, Document>();

  for (const doc of docs) {
    const existing = docNoMap.get(doc.docNo);
    if (existing) {
      issues.push({
        line: doc.line,
        severity: 'error',
        message: `🔢 Duplicate document number found: ${doc.docNo}`,
        found: `First occurrence: line ${existing.line} (${existing.docNo} - ${existing.name} [${existing.type}])\nDuplicate at: line ${doc.line} (${doc.docNo} - ${doc.name} [${doc.type}])`,
        reason: 'Each Atlas document must have a unique document number',
        action: `Renumber the duplicate at line ${doc.line} to a free slot among its siblings`,
      });
    } else {
      docNoMap.set(doc.docNo, doc);
    }
  }

  return issues;
}

function validateUUIDs(docs: Document[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const uuidMap = new Map<string, Document>();

  for (const doc of docs) {
    const { uuid } = doc;

    // Check if empty
    if (!uuid || uuid.trim() === '') {
      issues.push({
        line: doc.line,
        severity: 'error',
        message: '🆔 UUID is empty',
        action: 'Generate a new UUID for this document (`uuidgen`), or at https://www.uuidgenerator.net/',
      });
      continue;
    }

    // Check format
    if (!UUID_REGEX.test(uuid)) {
      issues.push({
        line: doc.line,
        severity: 'error',
        message: `🆔 UUID '${uuid}' is not a valid UUID format`,
        expected: '8 hex digits - 4 hex digits - 4 hex digits - 4 hex digits - 12 hex digits',
        example: '8650a584-01f8-45d6-882b-c14eab9879c4',
        action: 'Generate a new UUID at https://www.uuidgenerator.net/',
      });
      continue;
    }

    // Check uniqueness
    const existing = uuidMap.get(uuid);
    if (existing) {
      issues.push({
        line: doc.line,
        severity: 'error',
        message: `🆔 Duplicate UUID found: ${uuid}`,
        found: `First occurrence: line ${existing.line} (${existing.docNo} - ${existing.name} [${existing.type}])\nDuplicate at: line ${doc.line} (${doc.docNo} - ${doc.name} [${doc.type}])`,
        action: `Generate a new unique UUID for line ${doc.line}`,
      });
    } else {
      uuidMap.set(uuid, doc);
    }
  }

  return issues;
}

// ============================================================================
// Main Validator
// ============================================================================

// TODO: Delete this function once the duplicate UUIDs are fixed
function filterSuppressedIssues(issues: ValidationIssue[], docs: Document[], lines: string[]): ValidationIssue[] {
  if (SUPPRESSED_DUPLICATE_UUIDS.size === 0) return issues;

  return issues.filter((issue) => {
    // 1. Check if issue belongs to a suppressed document
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      if (SUPPRESSED_DUPLICATE_UUIDS.has(doc.uuid)) {
        // Range inclusive of start, exclusive of next doc start
        const nextDocLine = i + 1 < docs.length ? docs[i + 1].line : lines.length + 1;

        if (issue.line >= doc.line && issue.line < nextDocLine) {
          return false; // Suppress
        }

        // Special case: Missing blank line error might flag the next line which is the start of next doc
        if (issue.line === doc.line + 1 && issue.message.includes('Missing blank line after title')) {
          return false; // Suppress
        }
      }
    }

    // 2. Fallback: Check if the line itself contains a suppressed UUID
    // This handles cases where the document wasn't parsed (e.g. malformed title)
    // but we still want to suppress errors on that line if it has the UUID
    const lineContent = lines[issue.line - 1];
    if (lineContent) {
      const uuidMatch = lineContent.match(/UUID:\s*([a-f0-9-]{36})/i);
      if (uuidMatch && SUPPRESSED_DUPLICATE_UUIDS.has(uuidMatch[1])) {
        return false; // Suppress
      }
    }

    return true; // Keep
  });
}

/**
 * Documents must appear in canonical Atlas order.
 *
 * WHY THIS EXISTS. The Atlas used to be stored as one directory per document, so a
 * document's position was its filesystem path — `A.1.1.1` lived at `content/A/1/1/1/` and
 * nowhere else. It was therefore impossible for a document to appear out of order, and
 * nothing checked it. Once the Atlas is stored as a small number of composed files, order
 * is just where text happens to sit, and a bad merge or a mis-pasted edit can move a
 * document without changing a single character of its content.
 *
 * This is the assertion the PR #257 post-mortem asked for and never got. Its finding was
 * that "every check that was run is structurally blind to child-ordering" — a hand-resolved
 * merge had silently reordered 2,084 generated files and no tool noticed.
 *
 * THE RULE. Canonical order is a depth-first walk of the document-number tree where, at
 * each node, children that have their own document come first in ascending order, followed
 * by "phantom" children — number segments that exist only as a path to deeper documents,
 * such as the `.0.` in `A.1.4.5.0.4`. Those phantom subtrees sort last.
 *
 * That last part is not a detail. A naive "document numbers must ascend" rule reports 410
 * false errors on the current Atlas, because `A.1.1.1` legitimately precedes `A.1.1.0.3.1`.
 * Verified against the real Atlas: this rule reproduces the composed order for all 11,323
 * numbered documents exactly.
 *
 * Needed Research is skipped. An NR is placed immediately after the document it attaches
 * to, so its own number says nothing about where it belongs.
 */
function validateDocumentOrder(docs: Document[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const numbered = docs.filter((d) => !d.docNo.startsWith('NR-'));
  if (numbered.length < 2) return issues;

  const present = new Map<string, Document>();
  for (const d of numbered) if (!present.has(d.docNo)) present.set(d.docNo, d);

  // Every path prefix, including the phantom ones that carry no document of their own.
  const children = new Map<string, Set<string>>();
  for (const docNo of present.keys()) {
    const parts = docNo.split('.');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('.');
      const child = parts.slice(0, i + 1).join('.');
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent)!.add(child);
    }
  }

  // Segments are usually integers but not always — Scenario Variations use `var1`.
  const segmentKey = (docNo: string): [number, number, string] => {
    const last = docNo.split('.').pop()!;
    const n = Number(last);
    return Number.isInteger(n) ? [0, n, ''] : [1, 0, last];
  };
  const compare = (a: string, b: string): number => {
    const realA = present.has(a) ? 0 : 1;
    const realB = present.has(b) ? 0 : 1;
    if (realA !== realB) return realA - realB;
    const [ta, na, sa] = segmentKey(a);
    const [tb, nb, sb] = segmentKey(b);
    if (ta !== tb) return ta - tb;
    if (na !== nb) return na - nb;
    return sa.localeCompare(sb);
  };

  const expected: string[] = [];
  const walk = (node: string): void => {
    if (present.has(node)) expected.push(node);
    const kids = Array.from(children.get(node) ?? []).sort(compare);
    for (const kid of kids) walk(kid);
  };
  const roots = Array.from(
    new Set(Array.from(present.keys()).map((d) => d.split('.')[0]))
  ).sort();
  for (const root of roots) walk(root);

  const actual = numbered.map((d) => d.docNo);
  if (expected.length !== actual.length) return issues; // duplicates — reported elsewhere

  for (let i = 0; i < actual.length; i++) {
    if (actual[i] === expected[i]) continue;
    const doc = numbered[i];
    const shouldBe = present.get(expected[i]);
    issues.push({
      line: doc.line,
      severity: 'error',
      message: `📄 Document out of order: ${doc.docNo} appears where ${expected[i]} is expected`,
      found: `Line ${doc.line}: ${doc.docNo} - ${doc.name} [${doc.type}]`,
      expected:
        `${expected[i]}${shouldBe ? ` - ${shouldBe.name} [${shouldBe.type}]` : ''}` +
        `${shouldBe ? ` (currently at line ${shouldBe.line})` : ''}`,
      reason:
        'Documents must appear in document-number order. This is usually caused by a ' +
        'hand-resolved merge conflict, or by an edit pasted into the wrong place — the ' +
        'content of each document can be perfectly valid while their order is not.',
      action:
        `Move ${doc.docNo} back to its position in document-number order. Only the first ` +
        `misplaced document is reported; re-run after fixing it.`,
    });
    break; // one divergence cascades — reporting all of them buries the cause
  }

  return issues;
}

/**
 * Validate that every in-Atlas cross-reference resolves to a real document.
 *
 * Atlas cross-references are markdown links whose target is a bare UUID:
 *   [A.1.2.3 - Some Document](8650a584-01f8-45d6-882b-c14eab9879c4)
 *
 * Two failure modes, neither previously detected:
 *
 *  1. UNRESOLVABLE TARGET. The UUID belongs to no document. This is what a
 *     fabricated or mistyped reference looks like, and it is invisible on
 *     inspection because it still renders as a working-looking link. Error.
 *
 *  2. STALE LABEL. The target resolves, but the link text names a different
 *     document number than the target actually has -- the signature of a
 *     renumbering that moved a document without updating text pointing at it.
 *     The link still works; it just lies about where it goes. Warning, so that
 *     unusual-but-legitimate link text cannot fail a build.
 *
 * Only bare-UUID targets are considered; external URLs are out of scope.
 */
function validateCrossReferences(lines: string[], docs: Document[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const byUuid = new Map<string, Document>();
  for (const doc of docs) {
    if (doc.uuid && !byUuid.has(doc.uuid)) byUuid.set(doc.uuid, doc);
  }

  const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;
  const LABEL_RE = /^([A-Z](?:\.\d+)+)\s+-\s+/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('](')) continue;

    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(line)) !== null) {
      const text = m[1];
      const target = m[2];

      if (!UUID_REGEX.test(target)) continue;

      const targetDoc = byUuid.get(target);

      if (!targetDoc) {
        issues.push({
          line: i + 1,
          severity: 'error',
          message: `\u{1F517} Cross-reference points at a UUID that is not any document: ${target}`,
          found: `Link text: "${text}"`,
          action:
            'Look up the real UUID of the document being referenced and use that. A reference to a ' +
            'nonexistent UUID still renders as a link, so this cannot be caught by reading the diff.',
        });
        continue;
      }

      const label = text.match(LABEL_RE);
      if (label && label[1] !== targetDoc.docNo) {
        issues.push({
          line: i + 1,
          severity: 'warning',
          message: `\u{1F517} Cross-reference label says ${label[1]} but the target is ${targetDoc.docNo}`,
          found: `Link text: "${text}"\nTarget ${target} is ${targetDoc.docNo} - ${targetDoc.name} (line ${targetDoc.line})`,
          action: `Update the link text to "${targetDoc.docNo} - ${targetDoc.name}", or point the link at the intended document.`,
        });
      }
    }
  }

  return issues;
}

function validate(content: string): ValidationIssue[] {
  const lines = content.split(/\r?\n/);
  const issues: ValidationIssue[] = [];
  const docs: Document[] = [];

  // Parse all documents
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only process lines that look like Atlas document titles
    // Check for heading start and UUID comment, but allow malformed brackets to be caught by validation
    if (!line.match(/^#+\s/) || !line.includes('UUID')) continue;

    const result = parseTitleLine(line, i + 1);
    if (result.issue) {
      issues.push(result.issue);
    }
    if (result.doc) {
      docs.push(result.doc);
    }
  }

  // Run validations
  issues.push(...validateHierarchy(docs));
  issues.push(...validateBlankLines(lines, docs));
  issues.push(...validateExtraFields(lines, docs));

  for (const doc of docs) {
    const issue = validateDocumentNumber(doc);
    if (issue) issues.push(issue);
  }

  issues.push(...validateNesting(docs));
  issues.push(...validateUUIDs(docs));
  issues.push(...validateCrossReferences(lines, docs));
  issues.push(...validateDocumentNumberUniqueness(docs));
  issues.push(...validateDocumentOrder(docs));

  // Filter out suppressed issues
  const filteredIssues = filterSuppressedIssues(issues, docs, lines);

  // Sort by line number
  return filteredIssues.sort((a, b) => a.line - b.line);
}

// ============================================================================
// Output Formatting
// ============================================================================

function outputGitHubAnnotation(issue: ValidationIssue, filePath: string): void {
  if (!isGitHubActions || !core) return;

  const annotationProps = {
    file: filePath,
    startLine: issue.line,
    endLine: issue.line,
    title: issue.message,
  };

  const details = [];
  if (issue.found) details.push(`Found: ${issue.found}`);
  if (issue.expected) details.push(`Expected: ${issue.expected}`);
  if (issue.reason) details.push(`Reason: ${issue.reason}`);
  if (issue.example) details.push(`Example: ${issue.example}`);
  details.push(`Action: ${issue.action}`);

  const message = details.join(' | ');

  if (issue.severity === 'error') {
    core.error(message, annotationProps);
  } else {
    core.warning(message, annotationProps);
  }
}

function formatIssue(issue: ValidationIssue): string {
  const lines: string[] = [];
  const isError = issue.severity === 'error';
  const icon = isError ? '❌' : '⚠️';
  const prefix = isError ? 'ERROR' : 'WARNING';

  lines.push(`─────────────────────────────────────────`);
  lines.push(`${icon} ${prefix} at line ${issue.line}`);
  lines.push(`─────────────────────────────────────────`);
  lines.push(`  ${issue.message}`);

  if (issue.found) {
    lines.push('');
    lines.push('  🔍 Found:');
    issue.found.split('\n').forEach((l) => lines.push(`    ${l}`));
  }

  if (issue.expected) {
    lines.push('');
    lines.push('  ✨ Expected:');
    issue.expected.split('\n').forEach((l) => lines.push(`    ${l}`));
  }

  if (issue.reason) {
    lines.push('');
    lines.push(`  💡 Reason:`);
    lines.push(`    ${issue.reason}`);
  }

  if (issue.example) {
    lines.push('');
    lines.push(`  📋 Example:`);
    lines.push(`    ${issue.example}`);
  }

  lines.push('');
  lines.push(`  🔧 Action: ${issue.action}`);

  return lines.join('\n');
}

function printResults(issues: ValidationIssue[], filePath: string): void {
  if (issues.length === 0) {
    console.log('');
    console.log('═════════════════════════════════════════');
    console.log('  ✅ Validation passed - no issues found');
    console.log('═════════════════════════════════════════');
    return;
  }

  console.log('');

  // Print each issue (console output)
  issues.forEach((issue, index) => {
    console.log(formatIssue(issue));
    if (index < issues.length - 1) {
      console.log('');
      console.log('');
    }
  });

  // Output GitHub Actions annotations
  if (isGitHubActions) {
    // Use relative path if provided via environment variable, otherwise use the full path
    const annotationPath = process.env.GITHUB_ACTION_FILE_PATH || filePath;
    issues.forEach((issue) => outputGitHubAnnotation(issue, annotationPath));
  }

  // Summary
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;

  console.log('');
  console.log('═════════════════════════════════════════');
  console.log('  📊 VALIDATION SUMMARY');
  console.log('═════════════════════════════════════════');
  console.log(`  ❌ Errors:   ${errors}`);
  console.log(`  ⚠️  Warnings: ${warnings}`);
  console.log('─────────────────────────────────────────');
  if (errors > 0) {
    console.log('  Status: ❌ FAILED');
  } else {
    console.log('  Status: ✅ PASSED (warnings only)');
  }
  console.log('═════════════════════════════════════════');
}

// ============================================================================
// CLI
// ============================================================================

function main(): void {
  try {
    const args = process.argv.slice(2);

    if (args.length === 0) {
      console.error('Usage: npx tsx validate-atlas-markdown.ts <path-to-atlas.md>');
      process.exit(1);
    }

    const filePath = path.resolve(args[0]);

    if (!fs.existsSync(filePath)) {
      console.error(`Error: File not found: ${filePath}`);
      process.exit(1);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const issues = validate(content);

    printResults(issues, filePath);

    const hasErrors = issues.some((i) => i.severity === 'error');
    process.exit(hasErrors ? 1 : 0);
  } catch (error) {
    console.error('Fatal error during validation:');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run if called directly (ES modules check)
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

// Export for testing
export { validate };
export type { ValidationIssue, Document };
