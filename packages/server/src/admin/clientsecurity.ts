// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Filter, SearchRequest, WithId } from '@medplum/core';
import {
  badRequest,
  DEFAULT_MAX_SEARCH_COUNT,
  DEFAULT_SEARCH_COUNT,
  forbidden,
  isUUID,
  MEDPLUM_CLI_CLIENT_ID,
  Operator,
  singularize,
} from '@medplum/core';
import type { ClientApplication, Project } from '@medplum/fhirtypes';
import type { Request, Response } from 'express';
import { getConfig } from '../config/loader';
import { getAuthenticatedContext } from '../context';
import { sendOutcome } from '../fhir/outcomes';
import type {
  OAuthClientLintOptions,
  OAuthClientLintResult,
  RegistrationDiscoverableClient,
} from '../oauth/clientlint';
import { lintOAuthClient } from '../oauth/clientlint';
import { getClientRedirectUris, getStandardClientById } from '../oauth/clients';

const UNSIGNED_INTEGER_PATTERN = /^\d+$/;

interface RequestedClientIds {
  readonly ids?: string[];
}

function isSingleQueryValue(raw: unknown): raw is string | undefined {
  return raw === undefined || typeof raw === 'string';
}

function parseIdsParam(raw: unknown): RequestedClientIds | undefined {
  if (!isSingleQueryValue(raw)) {
    return undefined;
  }
  if (raw === undefined) {
    return {};
  }
  const ids = raw.split(',').filter((id) => id !== '');
  if (ids.length === 0) {
    return {};
  }
  if (ids.length > DEFAULT_MAX_SEARCH_COUNT || !ids.every(isUUID)) {
    return undefined;
  }
  return { ids };
}

function parseCountParam(raw: unknown): number | undefined {
  if (!isSingleQueryValue(raw)) {
    return undefined;
  }
  if (raw === undefined || raw === '') {
    return DEFAULT_SEARCH_COUNT;
  }
  if (!UNSIGNED_INTEGER_PATTERN.test(raw)) {
    return undefined;
  }
  const count = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(count) || count < 1) {
    return undefined;
  }
  return Math.min(count, DEFAULT_MAX_SEARCH_COUNT);
}

function parseOffsetParam(raw: unknown): number | undefined {
  if (!isSingleQueryValue(raw)) {
    return undefined;
  }
  if (raw === undefined || raw === '') {
    return 0;
  }
  if (!UNSIGNED_INTEGER_PATTERN.test(raw)) {
    return undefined;
  }
  const offset = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(offset)) {
    return undefined;
  }
  return offset;
}

function resolveProjectId(project: WithId<Project>, requestedProjectId: string | undefined): string | undefined {
  if (project.superAdmin) {
    if (requestedProjectId && isUUID(requestedProjectId)) {
      return requestedProjectId;
    }
    return project.id;
  }
  if (requestedProjectId && requestedProjectId !== project.id) {
    return undefined;
  }
  return project.id;
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
 * Reads the client applications of the reported project, evaluates each one, and responds with
 * `{ total, offset, count, results }` where every result carries the client id, name, redirect URIs, aggregate
 * status and findings. Accepts the optional query parameters `_id` (a single comma-separated list of client ids),
 * `_count` and `_offset`, and refuses a malformed value with an `invalid` outcome.
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

  const requestedIds = parseIdsParam(req.query['_id']);
  if (!requestedIds) {
    sendOutcome(res, badRequest('Invalid _id search parameter'));
    return;
  }

  const count = parseCountParam(req.query['_count']);
  if (count === undefined) {
    sendOutcome(res, badRequest('Invalid _count search parameter'));
    return;
  }

  const offset = parseOffsetParam(req.query['_offset']);
  if (offset === undefined) {
    sendOutcome(res, badRequest('Invalid _offset search parameter'));
    return;
  }

  const filters: Filter[] = [{ code: '_project', operator: Operator.EQUALS, value: resolvedProjectId }];
  if (requestedIds.ids) {
    filters.push({ code: '_id', operator: Operator.EQUALS, value: requestedIds.ids.join(',') });
  }

  const search: SearchRequest<ClientApplication> = {
    resourceType: 'ClientApplication',
    total: 'accurate',
    count,
    offset,
    filters,
  };

  const setting =
    resolvedProjectId === ctx.project.id
      ? ctx.project.setting
      : (await ctx.repo.readResource<Project>('Project', resolvedProjectId)).setting;

  const options: OAuthClientLintOptions = {
    partialRedirectMatchEnabled: setting?.find((s) => s.name === 'allow-dangerous-redirect')?.valueBoolean === true,
    registrationDiscoverableClients: buildRegistrationDiscoverableClients(),
  };

  const bundle = await ctx.repo.search<ClientApplication>(search);
  const results: OAuthClientLintResult[] = [];
  for (const entry of bundle.entry ?? []) {
    const client = entry.resource;
    if (client?.resourceType === 'ClientApplication') {
      results.push(lintOAuthClient(client, options));
    }
  }

  res.json({ total: bundle.total ?? results.length, offset, count, results });
}
