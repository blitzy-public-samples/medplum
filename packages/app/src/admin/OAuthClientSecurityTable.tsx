// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Skeleton, Stack, Text } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import type { SearchRequest } from '@medplum/core';
import { DEFAULT_SEARCH_COUNT, normalizeErrorString, Operator } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import type { SearchControlAdditionalColumn, SearchLoadEvent } from '@medplum/react';
import { SearchControl, StatusBadge, useMedplum } from '@medplum/react';
import type { JSX, ReactNode } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { getProjectId } from '../utils';

type OAuthClientLintStatus = 'pass' | 'warning' | 'fail';

interface OAuthClientLintFinding {
  readonly ruleId: string;
  readonly status: OAuthClientLintStatus;
  readonly redirectUri?: string;
  readonly reason: string;
  readonly remediation: string;
}

interface OAuthClientLintResult {
  readonly id: string;
  readonly name?: string;
  readonly redirectUris: string[];
  readonly status: OAuthClientLintStatus;
  readonly findings: OAuthClientLintFinding[];
}

interface OAuthClientLintReport {
  readonly total: number;
  readonly offset: number;
  readonly count: number;
  readonly results: OAuthClientLintResult[];
}

type SecurityCellState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'resolved'; readonly result: OAuthClientLintResult }
  | { readonly kind: 'unavailable' };

const LOADING_CELL: SecurityCellState = { kind: 'loading' };
const UNAVAILABLE_CELL: SecurityCellState = { kind: 'unavailable' };

const STATUS_COLORS: Record<OAuthClientLintStatus, string> = {
  pass: 'green',
  warning: 'orange',
  fail: 'red',
};

const UNRECOGNIZED_STATUS_COLOR = 'red';

const MALFORMED_REPORT_MESSAGE = 'The OAuth client security review returned an unexpected response.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isLintStatus(value: unknown): value is OAuthClientLintStatus {
  return value === 'pass' || value === 'warning' || value === 'fail';
}

function isLintFinding(value: unknown): value is OAuthClientLintFinding {
  return (
    isRecord(value) &&
    typeof value.ruleId === 'string' &&
    isLintStatus(value.status) &&
    (value.redirectUri === undefined || typeof value.redirectUri === 'string') &&
    typeof value.reason === 'string' &&
    typeof value.remediation === 'string'
  );
}

function isLintResult(value: unknown): value is OAuthClientLintResult {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    (value.name === undefined || typeof value.name === 'string') &&
    isStringArray(value.redirectUris) &&
    isLintStatus(value.status) &&
    Array.isArray(value.findings) &&
    value.findings.every(isLintFinding)
  );
}

/**
 * Narrows an OAuth client security response to the results it carries that match the endpoint contract.
 * @param response - The raw response body returned by the security review endpoint.
 * @returns The validated report when the envelope is well formed, together with whether any part of the response
 * failed validation and was discarded.
 */
function parseSecurityReport(response: unknown): { report?: OAuthClientLintReport; malformed: boolean } {
  if (
    !isRecord(response) ||
    typeof response.total !== 'number' ||
    typeof response.offset !== 'number' ||
    typeof response.count !== 'number' ||
    !Array.isArray(response.results)
  ) {
    return { malformed: true };
  }

  const results = response.results.filter(isLintResult);
  return {
    report: { total: response.total, offset: response.offset, count: response.count, results },
    malformed: results.length !== response.results.length,
  };
}

function getStatusColor(status: string): string {
  return isLintStatus(status) ? STATUS_COLORS[status] : UNRECOGNIZED_STATUS_COLOR;
}

function renderEmptyCell(): JSX.Element {
  return (
    <Text c="dimmed" size="sm">
      —
    </Text>
  );
}

/**
 * Renders the read-only OAuth client security review table for the current project.
 * @returns The table of client applications with their registered redirect URIs and security status.
 */
export function OAuthClientSecurityTable(): JSX.Element {
  const medplum = useMedplum();
  const projectId = getProjectId(medplum);
  const navigate = useNavigate();

  const [cellStates, setCellStates] = useState<Record<string, SecurityCellState>>({});
  const requestGenerationRef = useRef<number>(0);

  const [search, setSearch] = useState<SearchRequest>({
    resourceType: 'ClientApplication',
    fields: ['name'],
    filters: [{ code: '_project', operator: Operator.EQUALS, value: projectId }],
    count: DEFAULT_SEARCH_COUNT,
    total: 'accurate',
  });

  const handleLoad = useCallback(
    (e: SearchLoadEvent): void => {
      const entries = e.response.entry ?? [];
      const ids = Array.from(
        new Set(entries.map((entry) => entry.resource?.id).filter((id): id is string => id !== undefined))
      );
      const generation = requestGenerationRef.current + 1;
      requestGenerationRef.current = generation;

      if (ids.length === 0) {
        setCellStates({});
        return;
      }

      const loadingStates: Record<string, SecurityCellState> = {};
      for (const id of ids) {
        loadingStates[id] = LOADING_CELL;
      }
      setCellStates(loadingStates);

      medplum
        .get<unknown>(`admin/projects/${projectId}/oauth-security?_id=${ids.join(',')}`, { cache: 'no-cache' })
        .then((response: unknown) => {
          if (requestGenerationRef.current !== generation) {
            return;
          }
          const { report, malformed } = parseSecurityReport(response);
          const resultsById = new Map<string, OAuthClientLintResult>(
            (report?.results ?? []).map((result) => [result.id, result])
          );
          const nextStates: Record<string, SecurityCellState> = {};
          for (const id of ids) {
            const result = resultsById.get(id);
            nextStates[id] = result ? { kind: 'resolved', result } : UNAVAILABLE_CELL;
          }
          setCellStates(nextStates);
          if (malformed) {
            showNotification({ color: 'red', message: MALFORMED_REPORT_MESSAGE, autoClose: false });
          }
        })
        .catch((err: unknown) => {
          if (requestGenerationRef.current !== generation) {
            return;
          }
          const nextStates: Record<string, SecurityCellState> = {};
          for (const id of ids) {
            nextStates[id] = UNAVAILABLE_CELL;
          }
          setCellStates(nextStates);
          showNotification({ color: 'red', message: normalizeErrorString(err), autoClose: false });
        });
    },
    [medplum, projectId]
  );

  const additionalColumns = useMemo<SearchControlAdditionalColumn[]>(
    () => [
      {
        name: 'Redirect URIs',
        renderCell: (resource: Resource): ReactNode => {
          const cellState = resource.id ? cellStates[resource.id] : undefined;
          if (cellState?.kind === 'loading') {
            return <Skeleton height="var(--mantine-font-size-sm)" radius="sm" />;
          }
          if (cellState?.kind !== 'resolved') {
            return renderEmptyCell();
          }
          const uris = cellState.result.redirectUris;
          if (uris.length === 0) {
            return renderEmptyCell();
          }
          return (
            <Stack gap="xs">
              {uris.map((uri, index) => (
                <Text key={`${index}-${uri}`} size="sm">
                  {uri}
                </Text>
              ))}
            </Stack>
          );
        },
      },
      {
        name: 'Security',
        renderCell: (resource: Resource): ReactNode => {
          const cellState = resource.id ? cellStates[resource.id] : undefined;
          if (cellState?.kind === 'resolved') {
            const status = cellState.result.status;
            return <StatusBadge status={status} color={getStatusColor(status)} variant="light" />;
          }
          if (cellState?.kind === 'loading') {
            return <Skeleton height={22} width={70} radius="xl" />;
          }
          return renderEmptyCell();
        },
      },
    ],
    [cellStates]
  );

  return (
    <SearchControl
      search={search}
      hideToolbar
      hideFilters
      onChange={(e) => setSearch(e.definition)}
      onClick={(e) => navigate(`./${e.resource.id}`)}
      onAuxClick={(e) => navigate(`./${e.resource.id}`)}
      onLoad={handleLoad}
      additionalColumns={additionalColumns}
    />
  );
}
