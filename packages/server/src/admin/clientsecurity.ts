// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Filter, SearchRequest, WithId } from '@medplum/core';
import {
  badRequest,
  contentTooLarge,
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
 * The maximum number of client applications one report request addresses. `_count` is clamped to this value, and an
 * `_id` list longer than this is refused with `badRequest`.
 */
const MAX_REPORT_CLIENTS_PER_REQUEST = 200;

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
  return Math.min(count, MAX_REPORT_CLIENTS_PER_REQUEST);
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
  res.json({ total, offset, count, returned: 0, truncated: false, results: [] });
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
    if (requestedIds.length > MAX_REPORT_CLIENTS_PER_REQUEST) {
      sendOutcome(
        res,
        badRequest('_id search parameter exceeds maximum of ' + MAX_REPORT_CLIENTS_PER_REQUEST + ' client ids')
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
          MAX_REPORT_CLIENTS_PER_REQUEST +
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

  res.json({ total, offset, count, returned: results.length, truncated, results });
}
