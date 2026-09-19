// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Filter, SearchRequest, WithId } from '@medplum/core';
import {
  badRequest,
  contentTooLarge,
  DEFAULT_MAX_SEARCH_COUNT,
  DEFAULT_SEARCH_COUNT,
  forbidden,
  getStatus,
  isUUID,
  MEDPLUM_CLI_CLIENT_ID,
  OperationOutcomeError,
  Operator,
  singularize,
} from '@medplum/core';
import type { Bundle, ClientApplication, Project, ProjectSetting } from '@medplum/fhirtypes';
import type { Request, Response } from 'express';
import { getConfig } from '../config/loader';
import { getAuthenticatedContext } from '../context';
import { sendOutcome } from '../fhir/outcomes';
import type { Repository } from '../fhir/repo';
import type {
  OAuthClientLintFinding,
  OAuthClientLintOptions,
  OAuthClientLintResult,
  RegistrationDiscoverableClient,
} from '../oauth/clientlint';
import { lintOAuthClient } from '../oauth/clientlint';
import { getClientRedirectUris, getStandardClientById } from '../oauth/clients';

const UNSIGNED_INTEGER_PATTERN = /^\d+$/;
const REPORT_QUERY_PARAMS = ['_id', '_count', '_offset'] as const;

/**
 * The maximum number of client ids one report request names with `_id`. A longer list is refused with `badRequest`.
 * An `_id` list long enough to carry the request line past the HTTP header budget of the server is refused by the
 * HTTP server itself, before this handler runs, with a bodyless HTTP 431.
 */
const MAX_REPORT_CLIENT_IDS_PER_REQUEST = 200;

/**
 * The maximum serialized size, in UTF-8 bytes, of one report response. A client evaluation that does not fit within
 * the remaining bytes is not admitted, so no response exceeds this size. A page cut short by this bound reports
 * `truncated: true` and serves `returned` results; when the first evaluation of a page does not fit on its own, its
 * findings are bounded to the available bytes and the result reports how many were left out in `omittedFindings`.
 */
const MAX_REPORT_RESPONSE_BYTES = 4 * 1024 * 1024;

/** The bytes one element adds to a serialized JSON array beyond its own length: the element separator. */
const ELEMENT_SEPARATOR_BYTES = 1;

/** One evaluation whose findings were bounded by `MAX_REPORT_RESPONSE_BYTES`. */
interface BoundedOAuthClientLintResult extends OAuthClientLintResult {
  /** The number of findings the response left out. */
  readonly omittedFindings: number;
}

/** One entry of the `results` array of a report response. */
type ReportResult = OAuthClientLintResult | BoundedOAuthClientLintResult;

/**
 * The body of one report response. Every response this handler sends carries exactly these six members; a refused
 * request carries an `OperationOutcome` instead.
 */
interface OAuthClientSecurityReport {
  /** The number of client applications the search matched, independent of `count` and `offset`. */
  readonly total: number;
  /** The normalized `_offset` the search used. */
  readonly offset: number;
  /** The normalized `_count` the search used. */
  readonly count: number;
  /** The number of entries in `results`, which is at most `count`. */
  readonly returned: number;
  /** True when {@link MAX_REPORT_RESPONSE_BYTES} cut the page short or bounded the findings of its last entry. */
  readonly truncated: boolean;
  /**
   * One evaluation per client application the page serves, in search order. Each entry carries `id`, `name`,
   * `redirectUris`, `status` and `findings`, and additionally `omittedFindings` when its findings were bounded.
   */
  readonly results: ReportResult[];
}

/** The `setting` list of the project a report describes. */
interface ReportedProjectSetting {
  readonly setting?: ProjectSetting[];
}

function reportQuery(req: Request): URLSearchParams {
  const separator = req.originalUrl.indexOf('?');
  return new URLSearchParams(separator === -1 ? '' : req.originalUrl.slice(separator + 1));
}

function findRefusedParam(query: URLSearchParams): string | undefined {
  const keys = Array.from(query.keys());
  return REPORT_QUERY_PARAMS.find(
    (name) => query.getAll(name).length > 1 || keys.some((key) => key.startsWith(name + '['))
  );
}

function parseCountParam(raw: string | null): number | undefined {
  if (raw === null || raw === '') {
    return DEFAULT_SEARCH_COUNT;
  }
  if (!UNSIGNED_INTEGER_PATTERN.test(raw)) {
    return undefined;
  }
  const count = Number.parseInt(raw, 10);
  if (count < 1) {
    return undefined;
  }
  return Math.min(count, DEFAULT_MAX_SEARCH_COUNT);
}

function parseOffsetParam(raw: string | null): number | undefined {
  if (raw === null || raw === '') {
    return 0;
  }
  if (!UNSIGNED_INTEGER_PATTERN.test(raw)) {
    return undefined;
  }
  const offset = Number.parseInt(raw, 10);
  if (!Number.isFinite(offset)) {
    return undefined;
  }
  return offset;
}

function resolveProjectId(project: WithId<Project>, requestedProjectId: string | undefined): string | undefined {
  if (project.superAdmin) {
    return requestedProjectId !== undefined && isUUID(requestedProjectId) ? requestedProjectId : project.id;
  }
  if (requestedProjectId === undefined || requestedProjectId === project.id) {
    return project.id;
  }
  return undefined;
}

/**
 * Determines whether a repository call failed with a `forbidden` outcome.
 * @param err - The error a repository call threw.
 * @returns True when the error carries a `forbidden` operation outcome.
 */
function isForbiddenError(err: unknown): boolean {
  return err instanceof OperationOutcomeError && getStatus(err.outcome) === 403;
}

/**
 * Searches the client applications a report describes.
 * @param repo - The repository of the calling user.
 * @param search - The search request the handler assembled.
 * @returns The matching bundle, or undefined when the access policy of the calling user permits no client
 * application of the reported project.
 */
async function searchReportedClients(
  repo: Repository,
  search: SearchRequest<ClientApplication>
): Promise<Bundle<WithId<ClientApplication>> | undefined> {
  try {
    return await repo.search<ClientApplication>(search);
  } catch (err) {
    if (isForbiddenError(err)) {
      return undefined;
    }
    throw err;
  }
}

/**
 * Reads the `setting` list of the project a report describes.
 * @param repo - The repository of the calling user.
 * @param projectId - The id of the project the report describes.
 * @returns The `setting` list of that project, or undefined when the access policy of the calling user permits no
 * read of it.
 */
async function readReportedProjectSetting(
  repo: Repository,
  projectId: string
): Promise<ReportedProjectSetting | undefined> {
  try {
    const project = await repo.readResource<Project>('Project', projectId);
    return { setting: project.setting };
  } catch (err) {
    if (isForbiddenError(err)) {
      return undefined;
    }
    throw err;
  }
}

/**
 * Measures the serialized size of a value.
 * @param value - The value the response would carry.
 * @returns The length of the serialized value in UTF-8 bytes.
 */
function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Bounds the findings of one evaluation to the response bytes available for it.
 * @param result - The evaluation to bound.
 * @param availableBytes - The bytes the serialized evaluation may occupy.
 * @returns The evaluation carrying the findings that fit and the count of those left out, or undefined when the
 * evaluation does not fit even with no findings at all.
 */
function boundResultFindings(
  result: OAuthClientLintResult,
  availableBytes: number
): BoundedOAuthClientLintResult | undefined {
  const findings: OAuthClientLintFinding[] = [];
  let bytes = serializedBytes({ ...result, findings, omittedFindings: result.findings.length });
  if (bytes > availableBytes) {
    return undefined;
  }
  for (const finding of result.findings) {
    const findingBytes = serializedBytes(finding) + ELEMENT_SEPARATOR_BYTES;
    if (bytes + findingBytes > availableBytes) {
      break;
    }
    bytes += findingBytes;
    findings.push(finding);
  }
  return { ...result, findings, omittedFindings: result.findings.length - findings.length };
}

/**
 * Sends a report that carries no client application.
 * @param res - The response.
 * @param total - The number of client applications the search matched.
 * @param offset - The normalized `_offset` of the request.
 * @param count - The normalized `_count` of the request.
 */
function sendEmptyReport(res: Response, total: number, offset: number, count: number): void {
  const report: OAuthClientSecurityReport = { total, offset, count, returned: 0, truncated: false, results: [] };
  res.json(report);
}

function buildRegistrationDiscoverableClients(): RegistrationDiscoverableClient[] {
  const entries: RegistrationDiscoverableClient[] = [];
  const builtInClient = getStandardClientById(MEDPLUM_CLI_CLIENT_ID);
  if (builtInClient) {
    entries.push({
      id: MEDPLUM_CLI_CLIENT_ID,
      redirectUris: getClientRedirectUris(builtInClient),
      source: 'built-in',
    });
  }
  for (const configuredClient of getConfig().defaultOAuthClients ?? []) {
    entries.push({
      id: configuredClient.id,
      redirectUris: getClientRedirectUris(configuredClient),
      source: 'config',
    });
  }
  return entries;
}

/**
 * Handles requests to "GET /admin/projects/{projectId}/oauth-security".
 *
 * Three query parameters are read and every other one is ignored:
 *
 * - `_id` — one comma-separated list of at most {@link MAX_REPORT_CLIENT_IDS_PER_REQUEST} client ids. Empty segments
 *   are discarded, and a list that reduces to nothing names no client in particular.
 * - `_count` — the page size. Absent or empty it is {@link DEFAULT_SEARCH_COUNT}; a larger value than
 *   {@link DEFAULT_MAX_SEARCH_COUNT} is clamped to it, so the normalized value is always 1 to
 *   {@link DEFAULT_MAX_SEARCH_COUNT}.
 * - `_offset` — the first client of the page, 0 when absent or empty, and never clamped.
 *
 * A repeated, bracketed or otherwise malformed value of any of the three, and an `_id` list above the maximum, are
 * refused with `badRequest`. An `_offset` within the matched result set but above the configured `maxSearchOffset` is
 * refused with `badRequest` naming `_id` as the way to reach those clients, while an `_offset` at or beyond the
 * matched total serves an empty report. A request line long enough to exceed the HTTP header budget of the server —
 * which an `_id` list of a few hundred ids reaches — is refused by the HTTP server itself, before this handler runs,
 * with a bodyless HTTP 431.
 *
 * A successful request responds with an {@link OAuthClientSecurityReport}: `total`, `offset`, `count`, `returned`,
 * `truncated` and `results`. A single evaluation too large to serve at all is refused with `contentTooLarge`.
 * @param req - The request.
 * @param res - The response.
 */
export async function clientSecurityHandler(req: Request, res: Response): Promise<void> {
  const ctx = getAuthenticatedContext();

  const resolvedProjectId = resolveProjectId(ctx.project, singularize(req.params.projectId));
  if (!resolvedProjectId) {
    sendOutcome(res, forbidden);
    return;
  }

  const query = reportQuery(req);
  const refusedParam = findRefusedParam(query);
  if (refusedParam) {
    sendOutcome(res, badRequest('Invalid ' + refusedParam + ' search parameter'));
    return;
  }

  const rawIds = query.get('_id');
  let ids: string[] | undefined;
  if (rawIds) {
    const requestedIds = rawIds.split(',').filter((id) => id !== '');
    if (requestedIds.length > MAX_REPORT_CLIENT_IDS_PER_REQUEST) {
      sendOutcome(
        res,
        badRequest('_id search parameter exceeds maximum of ' + MAX_REPORT_CLIENT_IDS_PER_REQUEST + ' client ids')
      );
      return;
    }
    if (!requestedIds.every(isUUID)) {
      sendOutcome(res, badRequest('Invalid _id search parameter'));
      return;
    }
    if (requestedIds.length > 0) {
      ids = requestedIds;
    }
  }

  const count = parseCountParam(query.get('_count'));
  if (count === undefined) {
    sendOutcome(res, badRequest('Invalid _count search parameter'));
    return;
  }

  const offset = parseOffsetParam(query.get('_offset'));
  if (offset === undefined) {
    sendOutcome(res, badRequest('Invalid _offset search parameter'));
    return;
  }

  const filters: Filter[] = [{ code: '_project', operator: Operator.EQUALS, value: resolvedProjectId }];
  if (ids) {
    filters.push({ code: '_id', operator: Operator.EQUALS, value: ids.join(',') });
  }

  const search: SearchRequest<ClientApplication> = {
    resourceType: 'ClientApplication',
    total: 'accurate',
    count,
    offset,
    filters,
  };

  const reportedProject =
    resolvedProjectId === ctx.project.id
      ? { setting: ctx.project.setting }
      : await readReportedProjectSetting(ctx.repo, resolvedProjectId);
  if (!reportedProject) {
    sendEmptyReport(res, 0, offset, count);
    return;
  }

  const maxSearchOffset = getConfig().maxSearchOffset;
  if (offset > maxSearchOffset) {
    const matched = await searchReportedClients(ctx.repo, { ...search, count: 0, offset: 0 });
    if (!matched) {
      sendEmptyReport(res, 0, offset, count);
      return;
    }
    const matchedTotal = matched.total ?? 0;
    if (offset >= matchedTotal) {
      sendEmptyReport(res, matchedTotal, offset, count);
      return;
    }
    sendOutcome(
      res,
      badRequest(
        '_offset search parameter exceeds the maximum supported offset of ' +
          maxSearchOffset +
          '; request an offset of at most ' +
          maxSearchOffset +
          ', or name up to ' +
          MAX_REPORT_CLIENT_IDS_PER_REQUEST +
          ' client ids with _id'
      )
    );
    return;
  }

  const options: OAuthClientLintOptions = {
    partialRedirectMatchEnabled:
      reportedProject.setting?.find((s) => s.name === 'allow-dangerous-redirect')?.valueBoolean === true,
    registrationDiscoverableClients: buildRegistrationDiscoverableClients(),
  };

  const bundle = await searchReportedClients(ctx.repo, search);
  if (!bundle) {
    sendEmptyReport(res, 0, offset, count);
    return;
  }

  const total = bundle.total ?? bundle.entry?.length ?? 0;
  const results: ReportResult[] = [];
  let truncated = false;
  let responseBytes = serializedBytes({ total, offset, count, returned: count, truncated: false, results: [] });
  for (const entry of bundle.entry ?? []) {
    const client = entry.resource;
    if (client?.resourceType !== 'ClientApplication') {
      continue;
    }
    const result = lintOAuthClient(client, options);
    const resultBytes = serializedBytes(result) + ELEMENT_SEPARATOR_BYTES;
    if (responseBytes + resultBytes <= MAX_REPORT_RESPONSE_BYTES) {
      responseBytes += resultBytes;
      results.push(result);
      continue;
    }
    if (results.length > 0) {
      truncated = true;
      break;
    }
    const bounded = boundResultFindings(result, MAX_REPORT_RESPONSE_BYTES - responseBytes - ELEMENT_SEPARATOR_BYTES);
    if (!bounded) {
      sendOutcome(
        res,
        contentTooLarge(
          'OAuth client security report for client ' +
            client.id +
            ' at offset ' +
            offset +
            ' exceeds the maximum response size of ' +
            MAX_REPORT_RESPONSE_BYTES +
            ' bytes; request the next page from offset ' +
            (offset + 1)
        )
      );
      return;
    }
    results.push(bounded);
    truncated = true;
    break;
  }

  const report: OAuthClientSecurityReport = { total, offset, count, returned: results.length, truncated, results };
  res.json(report);
}
