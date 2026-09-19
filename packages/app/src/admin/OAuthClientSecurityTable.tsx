// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, rem, Skeleton, Stack, Text } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import type { SearchRequest } from '@medplum/core';
import { DEFAULT_SEARCH_COUNT, Operator } from '@medplum/core';
import type { ClientApplication, Resource } from '@medplum/fhirtypes';
import type { SearchControlAdditionalColumn, SearchLoadEvent } from '@medplum/react';
import { MedplumLink, SearchControl, StatusBadge, useMedplum } from '@medplum/react';
import type { CSSProperties, JSX, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  pass: 'green.6',
  warning: 'orange.6',
  fail: 'red.6',
};

const STATUS_VARIANT = 'filled';

const STATUS_LABEL_COLOR = 'black';

const MALFORMED_REPORT_MESSAGE = 'The OAuth client security review returned an unexpected response.';

const REQUEST_FAILED_MESSAGE = 'The OAuth client security review could not be loaded.';

const DISMISS_BUTTON_PROPS = { 'aria-label': 'Dismiss' };

const PROJECT_FILTER_CODE = '_project';

const CLIENT_APPLICATION_SORT_CODE = 'name';

const BIDI_CONTROL_PATTERN = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Replaces every Unicode bidirectional control character of a string with a visible code point token.
 * @param value - The text to render, as the security report or the searched resource carries it.
 * @returns The same text with each bidirectional control replaced by its `<U+XXXX>` token, unchanged when it
 * carries none.
 */
function escapeBidiControls(value: string): string {
  return value.replace(
    BIDI_CONTROL_PATTERN,
    (control) => '<U+' + control.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') + '>'
  );
}

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
  return isLintStatus(status) ? STATUS_COLORS[status] : STATUS_COLORS.fail;
}

const SECURITY_CELL_MIN_WIDTH = rem(80);
const SECURITY_CELL_MIN_HEIGHT = rem(22);
const STATUS_PLACEHOLDER_HEIGHT = 20;
const STATUS_PLACEHOLDER_WIDTH = 74;
const DETAIL_PATH_PREFIX = '/admin/oauth-security/';
const DETAIL_LINK_TEXT = 'Review';
const CELL_TEXT_STYLE: CSSProperties = { overflowWrap: 'anywhere' };

function renderEmptyCell(): JSX.Element {
  return (
    <Text c="dimmed" size="sm">
      —
    </Text>
  );
}

/**
 * Renders one security status cell inside the width and height the column reserves for every cell state.
 * @param content - The status badge, the loading placeholder or the empty marker to render.
 * @returns The cell content inside the reserved-size container.
 */
function renderSecurityCell(content: ReactNode): JSX.Element {
  return (
    <Box data-testid="security-status" miw={SECURITY_CELL_MIN_WIDTH} mih={SECURITY_CELL_MIN_HEIGHT}>
      {content}
    </Box>
  );
}

/**
 * Merges the redirect URIs registered on a searched client application, deprecated singular field first.
 * @param resource - The client application row returned by the FHIR search.
 * @returns The redirect URIs the resource carries, empty when it carries none.
 */
function getResourceRedirectUris(resource: Resource): string[] {
  const { redirectUri, redirectUris } = resource as ClientApplication;
  return [
    ...(typeof redirectUri === 'string' && redirectUri !== '' ? [redirectUri] : []),
    ...(isStringArray(redirectUris) ? redirectUris : []),
  ];
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
    fields: [],
    filters: [{ code: PROJECT_FILTER_CODE, operator: Operator.EQUALS, value: projectId }],
    sortRules: [{ code: CLIENT_APPLICATION_SORT_CODE }],
    count: DEFAULT_SEARCH_COUNT,
    total: 'accurate',
  });

  useEffect(() => {
    medplum.invalidateSearches('ClientApplication');
  }, [medplum]);

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
            showNotification({
              color: 'red',
              message: MALFORMED_REPORT_MESSAGE,
              autoClose: false,
              closeButtonProps: DISMISS_BUTTON_PROPS,
            });
          }
        })
        .catch((err: unknown) => {
          console.error(err);
          if (requestGenerationRef.current !== generation) {
            return;
          }
          const nextStates: Record<string, SecurityCellState> = {};
          for (const id of ids) {
            nextStates[id] = UNAVAILABLE_CELL;
          }
          setCellStates(nextStates);
          showNotification({
            color: 'red',
            message: REQUEST_FAILED_MESSAGE,
            autoClose: false,
            closeButtonProps: DISMISS_BUTTON_PROPS,
          });
        });
    },
    [medplum, projectId]
  );

  const additionalColumns = useMemo<SearchControlAdditionalColumn[]>(
    () => [
      {
        name: 'Name',
        renderCell: (resource: Resource): ReactNode => {
          const { name } = resource as ClientApplication;
          if (!name) {
            return renderEmptyCell();
          }
          return (
            <Text size="sm" style={CELL_TEXT_STYLE}>
              {escapeBidiControls(name)}
            </Text>
          );
        },
      },
      {
        name: 'Security',
        renderCell: (resource: Resource): ReactNode => {
          const cellState = resource.id ? cellStates[resource.id] : undefined;
          if (cellState?.kind === 'resolved') {
            const status = cellState.result.status;
            return renderSecurityCell(
              <StatusBadge
                status={status}
                color={getStatusColor(status)}
                variant={STATUS_VARIANT}
                c={STATUS_LABEL_COLOR}
              />
            );
          }
          if (cellState?.kind === 'loading') {
            return renderSecurityCell(
              <Skeleton height={STATUS_PLACEHOLDER_HEIGHT} width={STATUS_PLACEHOLDER_WIDTH} radius="xl" />
            );
          }
          return renderSecurityCell(renderEmptyCell());
        },
      },
      {
        name: 'Redirect URIs',
        renderCell: (resource: Resource): ReactNode => {
          const cellState = resource.id ? cellStates[resource.id] : undefined;
          const uris =
            cellState?.kind === 'resolved' ? cellState.result.redirectUris : getResourceRedirectUris(resource);
          if (uris.length === 0) {
            return renderEmptyCell();
          }
          return (
            <Stack gap="xs">
              {uris.map((uri, index) => (
                <Text key={`${index}-${uri}`} size="sm" style={CELL_TEXT_STYLE}>
                  {escapeBidiControls(uri)}
                </Text>
              ))}
            </Stack>
          );
        },
      },
      {
        name: 'Details',
        renderCell: (resource: Resource): ReactNode => {
          const clientId = resource.id;
          if (!clientId) {
            return renderEmptyCell();
          }
          const { name } = resource as ClientApplication;
          return (
            <MedplumLink
              to={`${DETAIL_PATH_PREFIX}${clientId}`}
              label={`${DETAIL_LINK_TEXT} ${escapeBidiControls(name ?? clientId)}`}
              size="sm"
            >
              {DETAIL_LINK_TEXT}
            </MedplumLink>
          );
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
