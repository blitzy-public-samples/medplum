// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  ActionIcon,
  Button,
  Center,
  Group,
  Loader,
  Menu,
  Pagination,
  Table,
  Text,
  UnstyledButton,
} from '@mantine/core';
import type { Filter, SearchRequest } from '@medplum/core';
import {
  DEFAULT_SEARCH_COUNT,
  deepEquals,
  formatSearchQuery,
  isDataTypeLoaded,
  normalizeOperationOutcome,
} from '@medplum/core';
import type { Bundle, OperationOutcome, Resource, SearchParameter } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react-hooks';
import {
  IconAdjustmentsHorizontal,
  IconBoxMultiple,
  IconColumns,
  IconFilePlus,
  IconFilter,
  IconRefresh,
  IconTableExport,
  IconTrash,
} from '@tabler/icons-react';
import type { ChangeEvent, JSX, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Container } from '../Container/Container';
import { OperationOutcomeAlert } from '../OperationOutcomeAlert/OperationOutcomeAlert';
import { SearchExportDialog } from '../SearchExportDialog/SearchExportDialog';
import { SearchFieldEditor } from '../SearchFieldEditor/SearchFieldEditor';
import { SearchFilterEditor } from '../SearchFilterEditor/SearchFilterEditor';
import { SearchFilterValueDialog } from '../SearchFilterValueDialog/SearchFilterValueDialog';
import { SearchFilterValueDisplay } from '../SearchFilterValueDisplay/SearchFilterValueDisplay';
import { SearchPopupMenu } from '../SearchPopupMenu/SearchPopupMenu';
import { isAuxClick, isCheckboxCell, killEvent } from '../utils/dom';
import { getPaginationControlProps } from '../utils/pagination';
import classes from './SearchControl.module.css';
import type { SearchControlField } from './SearchControlField';
import { getFieldDefinitions } from './SearchControlField';
import { addFilter, buildFieldNameString, getOpString, renderValue, setPage } from './SearchUtils';

export class SearchChangeEvent extends Event {
  readonly definition: SearchRequest;

  constructor(definition: SearchRequest) {
    super('change');
    this.definition = definition;
  }
}

export class SearchLoadEvent extends Event {
  readonly response: Bundle;

  constructor(response: Bundle) {
    super('load');
    this.response = response;
  }
}

export class SearchClickEvent extends Event {
  readonly resource: Resource;
  readonly browserEvent: MouseEvent;

  constructor(resource: Resource, browserEvent: MouseEvent) {
    super('click');
    this.resource = resource;
    this.browserEvent = browserEvent;
  }
}

/**
 * An additional, computed column appended after the search-result columns.
 *
 * Unlike the columns derived from {@link SearchControlProps.search} fields, an
 * additional column is not backed by a search parameter and has no sort/filter
 * menu: it renders arbitrary content per row. Use it for values that must be
 * computed or fetched separately from the searched resource (e.g. a related
 * resource's status).
 */
export interface SearchControlAdditionalColumn {
  /** The column header text. */
  readonly name: string;
  /** Renders the cell contents for the given row resource. */
  readonly renderCell: (resource: Resource) => ReactNode;
}

export interface SearchControlProps {
  readonly search: SearchRequest;
  readonly checkboxesEnabled?: boolean;
  /** Additional computed columns rendered after the search-result columns. */
  readonly additionalColumns?: readonly SearchControlAdditionalColumn[];
  /** The accessible name of the results table. Defaults to `"<resourceType> search results"`. */
  readonly tableAriaLabel?: string;
  readonly hideToolbar?: boolean;
  readonly hideFilters?: boolean;
  readonly onLoad?: (e: SearchLoadEvent) => void;
  readonly onChange?: (e: SearchChangeEvent) => void;
  readonly onClick?: (e: SearchClickEvent) => void;
  readonly onAuxClick?: (e: SearchClickEvent) => void;
  readonly onNew?: () => void;
  readonly onExport?: () => void;
  readonly onExportCsv?: () => void;
  readonly onExportTransactionBundle?: () => void;
  readonly onDelete?: (ids: string[]) => void;
  readonly onBulk?: (ids: string[]) => void;
}

interface SearchControlState {
  readonly searchResponse?: Bundle;
  /** The search request that produced {@link SearchControlState.searchResponse}. */
  readonly loadedSearch?: SearchRequest;
  readonly selected: { [id: string]: boolean };
  readonly fieldEditorVisible: boolean;
  readonly filterEditorVisible: boolean;
  readonly filterDialogVisible: boolean;
  readonly exportDialogVisible: boolean;
  readonly filterDialogFilter?: Filter;
  readonly filterDialogSearchParam?: SearchParameter;
  readonly dialogOpenTime?: number;
}

/**
 * The SearchControl component represents the embeddable search table control.
 * It includes the table, rows, headers, sorting, etc.
 * It does not include the field editor, filter editor, pagination buttons.
 * @param props - The SearchControl React props.
 * @returns The SearchControl React node.
 */
export function SearchControl(props: SearchControlProps): JSX.Element {
  const medplum = useMedplum();
  const [outcome, setOutcome] = useState<OperationOutcome | undefined>();
  const { search, onLoad } = props;

  const [memoizedSearch, setMemoizedSearch] = useState(search);

  if (!deepEquals(search, memoizedSearch)) {
    setMemoizedSearch(search);
  }

  const [state, setState] = useState<SearchControlState>({
    selected: {},
    fieldEditorVisible: false,
    filterEditorVisible: false,
    exportDialogVisible: false,
    filterDialogVisible: false,
  });

  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });

  const searchGenerationRef = useRef(0);

  const total = memoizedSearch.total ?? 'accurate';

  const loadResults = useCallback(
    (options?: RequestInit) => {
      searchGenerationRef.current++;
      const generation = searchGenerationRef.current;
      setOutcome(undefined);
      medplum
        .requestSchema(memoizedSearch.resourceType)
        .then(() =>
          medplum.search(
            memoizedSearch.resourceType,
            formatSearchQuery({ ...memoizedSearch, total, fields: undefined }),
            options
          )
        )
        .then((response) => {
          if (generation !== searchGenerationRef.current) {
            return;
          }
          setState({ ...stateRef.current, searchResponse: response, loadedSearch: memoizedSearch });
          if (onLoad) {
            onLoad(new SearchLoadEvent(response));
          }
        })
        .catch((reason) => {
          if (generation !== searchGenerationRef.current) {
            return;
          }
          setState({ ...stateRef.current, searchResponse: undefined, loadedSearch: undefined });
          setOutcome(normalizeOperationOutcome(reason));
        });
    },
    [medplum, memoizedSearch, total, onLoad]
  );

  const refreshResults = useCallback(() => {
    setState({ ...stateRef.current, searchResponse: undefined });
    loadResults({ cache: 'reload' });
  }, [loadResults]);

  useEffect(() => {
    loadResults();
  }, [loadResults]);

  function handleSingleCheckboxClick(e: ChangeEvent, id: string): void {
    e.stopPropagation();

    const el = e.target as HTMLInputElement;
    const checked = el.checked;
    const newSelected = { ...stateRef.current.selected };
    if (checked) {
      newSelected[id] = true;
    } else {
      delete newSelected[id];
    }
    setState({ ...stateRef.current, selected: newSelected });
  }

  function handleAllCheckboxClick(e: ChangeEvent): void {
    e.stopPropagation();

    const el = e.target as HTMLInputElement;
    const checked = el.checked;
    const newSelected = {} as { [id: string]: boolean };
    const searchResponse = stateRef.current.searchResponse;
    if (checked && searchResponse?.entry) {
      searchResponse.entry.forEach((entry) => {
        if (entry.resource?.id) {
          newSelected[entry.resource.id] = true;
        }
      });
    }
    setState({ ...stateRef.current, selected: newSelected });
  }

  function isAllSelected(): boolean {
    if (!state.searchResponse?.entry || state.searchResponse.entry.length === 0) {
      return false;
    }
    for (const e of state.searchResponse.entry) {
      if (e.resource?.id && !state.selected[e.resource.id]) {
        return false;
      }
    }
    return true;
  }

  /**
   * Emits a change event to the optional change listener.
   * @param newSearch - The new search definition.
   */
  function emitSearchChange(newSearch: SearchRequest): void {
    if (props.onChange) {
      props.onChange(new SearchChangeEvent(newSearch));
    }
  }

  /**
   * Handles a click on a order row.
   * @param e - The click event.
   * @param resource - The FHIR resource.
   */
  function handleRowClick(e: MouseEvent, resource: Resource): void {
    if (isCheckboxCell(e.target as Element)) {
      // Ignore clicks on checkboxes
      return;
    }

    if (e.button === 2) {
      // Ignore right clicks
      return;
    }

    killEvent(e);

    const isAux = isAuxClick(e);

    if (!isAux && props.onClick) {
      props.onClick(new SearchClickEvent(resource, e));
    }

    if (isAux && props.onAuxClick) {
      props.onAuxClick(new SearchClickEvent(resource, e));
    }
  }

  function isExportPassed(): boolean {
    return !!(props.onExport ?? props.onExportCsv ?? props.onExportTransactionBundle);
  }

  /**
   * Moves focus between the enabled pagination controls of the pagination navigation landmark.
   * Handles "ArrowRight" (next control), "ArrowLeft" (previous control), "Home" (first control) and "End" (last
   * control), and calls preventDefault only when focus moves.
   * @param e - The keyboard event captured by the pagination navigation landmark.
   */
  function handlePaginationKeyDown(e: KeyboardEvent<HTMLElement>): void {
    const buttons = Array.from(e.currentTarget.querySelectorAll('button')).filter((button) => !button.disabled);
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (currentIndex < 0) {
      return;
    }

    let nextIndex: number;
    switch (e.key) {
      case 'ArrowRight':
        nextIndex = currentIndex + 1;
        break;
      case 'ArrowLeft':
        nextIndex = currentIndex - 1;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = buttons.length - 1;
        break;
      default:
        return;
    }

    if (nextIndex === currentIndex || nextIndex < 0 || nextIndex >= buttons.length) {
      return;
    }

    e.preventDefault();
    buttons[nextIndex].focus();
  }

  if (outcome) {
    return <OperationOutcomeAlert outcome={outcome} />;
  }

  if (!isDataTypeLoaded(memoizedSearch.resourceType)) {
    return (
      <Center style={{ width: '100%', height: '100%' }}>
        <Loader />
      </Center>
    );
  }

  const checkboxColumn = props.checkboxesEnabled;
  const fields = getFieldDefinitions(memoizedSearch);
  const resourceType = memoizedSearch.resourceType;
  const lastResult = state.searchResponse;
  const entries = lastResult?.entry;
  const resources = entries?.map((e) => e.resource);
  const loadingNewSearch = !!lastResult && !!state.loadedSearch && !deepEquals(state.loadedSearch, memoizedSearch);
  const columnCount = (checkboxColumn ? 1 : 0) + fields.length + (props.additionalColumns?.length ?? 0);

  const buttonVariant = 'subtle';
  const buttonColor = 'gray';
  const iconSize = 16;
  const isMobile = window.innerWidth < 768;

  return (
    <div className={classes.root} data-testid="search-control">
      {!props.hideToolbar && (
        <Group justify="space-between" mb="xl">
          <Group gap={2}>
            <Button
              size="compact-md"
              variant={buttonVariant}
              color={buttonColor}
              leftSection={<IconColumns size={iconSize} />}
              onClick={() => setState({ ...stateRef.current, fieldEditorVisible: true, dialogOpenTime: Date.now() })}
            >
              Fields
            </Button>
            <Button
              size="compact-md"
              variant={buttonVariant}
              color={buttonColor}
              leftSection={<IconFilter size={iconSize} />}
              onClick={() => setState({ ...stateRef.current, filterEditorVisible: true, dialogOpenTime: Date.now() })}
            >
              Filters
            </Button>
            {props.onNew && (
              <Button
                size="compact-md"
                variant={buttonVariant}
                color={buttonColor}
                leftSection={<IconFilePlus size={iconSize} />}
                onClick={props.onNew}
              >
                New...
              </Button>
            )}
            {!isMobile && isExportPassed() && (
              <Button
                size="compact-md"
                variant={buttonVariant}
                color={buttonColor}
                leftSection={<IconTableExport size={iconSize} />}
                onClick={
                  props.onExport
                    ? props.onExport
                    : () => setState({ ...stateRef.current, exportDialogVisible: true, dialogOpenTime: Date.now() })
                }
              >
                Export...
              </Button>
            )}
            {!isMobile && props.onDelete && (
              <Button
                size="compact-md"
                variant={buttonVariant}
                color={buttonColor}
                leftSection={<IconTrash size={iconSize} />}
                onClick={() => (props.onDelete as (ids: string[]) => any)(Object.keys(state.selected))}
              >
                Delete...
              </Button>
            )}
            {!isMobile && props.onBulk && (
              <Button
                size="compact-md"
                variant={buttonVariant}
                color={buttonColor}
                leftSection={<IconBoxMultiple size={iconSize} />}
                onClick={() => (props.onBulk as (ids: string[]) => any)(Object.keys(state.selected))}
              >
                Bulk...
              </Button>
            )}
          </Group>
          <Group gap={2}>
            {lastResult && (
              <Text size="xs" c="dimmed" data-testid="count-display">
                {getStart(memoizedSearch, lastResult).toLocaleString()}-
                {getEnd(memoizedSearch, lastResult).toLocaleString()}
                {lastResult.total !== undefined &&
                  ` of ${memoizedSearch.total === 'estimate' ? '~' : ''}${lastResult.total?.toLocaleString()}`}
              </Text>
            )}
            <ActionIcon variant={buttonVariant} color={buttonColor} title="Refresh" onClick={refreshResults}>
              <IconRefresh size={iconSize} />
            </ActionIcon>
          </Group>
        </Group>
      )}
      <Table
        className={classes.table}
        aria-label={props.tableAriaLabel ?? `${resourceType} search results`}
        aria-busy={loadingNewSearch}
      >
        <Table.Thead>
          <Table.Tr>
            {checkboxColumn && (
              <Table.Th scope="col">
                <input
                  type="checkbox"
                  value="checked"
                  aria-label="all-checkbox"
                  data-testid="all-checkbox"
                  checked={isAllSelected()}
                  onChange={(e) => handleAllCheckboxClick(e)}
                />
              </Table.Th>
            )}
            {fields.map((field) => (
              <Table.Th key={field.name} scope="col" aria-sort={getColumnAriaSort(memoizedSearch, field)}>
                <Menu shadow="md" width={240} position="bottom-end">
                  <Menu.Target>
                    <UnstyledButton className={classes.control} p={2}>
                      <Group justify="space-between" wrap="nowrap">
                        <Text fw={500}>{buildFieldNameString(field.name)}</Text>
                        <Center className={classes.icon}>
                          <IconAdjustmentsHorizontal size={14} stroke={1.5} />
                        </Center>
                      </Group>
                    </UnstyledButton>
                  </Menu.Target>
                  <SearchPopupMenu
                    search={memoizedSearch}
                    searchParams={field.searchParams}
                    onPrompt={(searchParam, filter) => {
                      setState({
                        ...stateRef.current,
                        filterDialogVisible: true,
                        filterDialogSearchParam: searchParam,
                        filterDialogFilter: filter,
                        dialogOpenTime: Date.now(),
                      });
                    }}
                    onChange={(result) => {
                      emitSearchChange(result);
                    }}
                  />
                </Menu>
              </Table.Th>
            ))}
            {props.additionalColumns?.map((col) => (
              <Table.Th key={col.name} scope="col">
                <Text fw={500} p={2}>
                  {col.name}
                </Text>
              </Table.Th>
            ))}
          </Table.Tr>
          {!props.hideFilters && (
            <Table.Tr>
              {checkboxColumn && <Table.Th scope="col" />}
              {fields.map((field) => (
                <Table.Th key={field.name} scope="col">
                  {field.searchParams && (
                    <FilterDescription
                      resourceType={resourceType}
                      searchParams={field.searchParams}
                      filters={memoizedSearch.filters}
                    />
                  )}
                </Table.Th>
              ))}
              {props.additionalColumns?.map((col) => (
                <Table.Th key={col.name} scope="col" />
              ))}
            </Table.Tr>
          )}
        </Table.Thead>
        <Table.Tbody>
          {loadingNewSearch ? (
            <Table.Tr data-testid="search-control-loading-row">
              <Table.Td colSpan={columnCount}>
                <Center>
                  <Loader size="sm" />
                </Center>
              </Table.Td>
            </Table.Tr>
          ) : (
            resources?.map(
              (resource) =>
                resource && (
                  <Table.Tr
                    key={resource.id}
                    className={classes.tr}
                    data-testid="search-control-row"
                    onClick={(e) => handleRowClick(e, resource)}
                    onAuxClick={(e) => handleRowClick(e, resource)}
                  >
                    {checkboxColumn && (
                      <Table.Td>
                        <input
                          type="checkbox"
                          value="checked"
                          data-testid="row-checkbox"
                          aria-label={`Checkbox for ${resource.id}`}
                          checked={!!state.selected[resource.id as string]}
                          onChange={(e) => handleSingleCheckboxClick(e, resource.id as string)}
                        />
                      </Table.Td>
                    )}
                    {fields.map((field) => (
                      <Table.Td key={field.name}>{renderValue(resource, field)}</Table.Td>
                    ))}
                    {props.additionalColumns?.map((col) => (
                      <Table.Td key={col.name}>{col.renderCell(resource)}</Table.Td>
                    ))}
                  </Table.Tr>
                )
            )
          )}
        </Table.Tbody>
      </Table>
      {!loadingNewSearch && !resources?.length && (
        <Container>
          <Center style={{ height: 150 }}>
            <Text size="xl" c="dimmed">
              No results
            </Text>
          </Center>
        </Container>
      )}
      {lastResult && (
        <Center m="md" p="md">
          <nav aria-label={`${resourceType} search results pagination`} onKeyDown={handlePaginationKeyDown}>
            <Pagination
              value={getPage(memoizedSearch)}
              total={getTotalPages(memoizedSearch, lastResult)}
              onChange={(newPage) => emitSearchChange(setPage(memoizedSearch, newPage))}
              getControlProps={getPaginationControlProps}
            />
          </nav>
        </Center>
      )}
      <SearchFieldEditor
        key={`search-field-editor-${state.dialogOpenTime}`}
        search={memoizedSearch}
        visible={state.fieldEditorVisible}
        onOk={(result) => {
          emitSearchChange(result);
          setState({
            ...stateRef.current,
            fieldEditorVisible: false,
          });
        }}
        onCancel={() => {
          setState({
            ...stateRef.current,
            fieldEditorVisible: false,
          });
        }}
      />
      <SearchFilterEditor
        key={`search-filter-editor-${state.dialogOpenTime}`}
        search={memoizedSearch}
        visible={state.filterEditorVisible}
        onOk={(result) => {
          emitSearchChange(result);
          setState({
            ...stateRef.current,
            filterEditorVisible: false,
          });
        }}
        onCancel={() => {
          setState({
            ...stateRef.current,
            filterEditorVisible: false,
          });
        }}
      />
      <SearchExportDialog
        key={`search-export-dialog-${state.dialogOpenTime}`}
        visible={state.exportDialogVisible}
        exportCsv={props.onExportCsv}
        exportTransactionBundle={props.onExportTransactionBundle}
        onCancel={() => {
          setState({
            ...stateRef.current,
            exportDialogVisible: false,
          });
        }}
      />
      <SearchFilterValueDialog
        key={`search-filter-dialog-${state.dialogOpenTime}`}
        visible={state.filterDialogVisible}
        title={state.filterDialogSearchParam?.code ? buildFieldNameString(state.filterDialogSearchParam.code) : ''}
        resourceType={resourceType}
        searchParam={state.filterDialogSearchParam}
        filter={state.filterDialogFilter}
        defaultValue=""
        onOk={(filter) => {
          emitSearchChange(addFilter(memoizedSearch, filter.code, filter.operator, filter.value));
          setState({
            ...stateRef.current,
            filterDialogVisible: false,
          });
        }}
        onCancel={() => {
          setState({
            ...stateRef.current,
            filterDialogVisible: false,
          });
        }}
      />
    </div>
  );
}

interface FilterDescriptionProps {
  readonly resourceType: string;
  readonly searchParams: SearchParameter[];
  readonly filters?: Filter[];
}

function FilterDescription(props: FilterDescriptionProps): JSX.Element {
  const filters = (props.filters ?? []).filter((f) => props.searchParams.find((p) => p.code === f.code));
  if (filters.length === 0) {
    return <span>no filters</span>;
  }

  return (
    <>
      {filters.map((filter: Filter) => (
        <div key={`filter-${filter.code}-${filter.operator}-${filter.value}`}>
          {getOpString(filter.operator)}
          &nbsp;
          <SearchFilterValueDisplay resourceType={props.resourceType} filter={filter} />
        </div>
      ))}
    </>
  );
}

/**
 * Returns the `aria-sort` value of a column header cell.
 * @param search - The search request that carries the sort rules.
 * @param field - The column field definition.
 * @returns "ascending" or "descending" when a sort rule targets one of the column's search parameters, and undefined
 * for every other column, which leaves the attribute absent.
 */
function getColumnAriaSort(search: SearchRequest, field: SearchControlField): 'ascending' | 'descending' | undefined {
  const searchParams = field.searchParams;
  if (!searchParams || searchParams.length === 0) {
    return undefined;
  }
  const sortRule = search.sortRules?.find((rule) => searchParams.some((searchParam) => searchParam.code === rule.code));
  if (!sortRule) {
    return undefined;
  }
  return sortRule.descending ? 'descending' : 'ascending';
}

function getPage(search: SearchRequest): number {
  return Math.floor((search.offset ?? 0) / (search.count ?? DEFAULT_SEARCH_COUNT)) + 1;
}

function getTotalPages(search: SearchRequest, lastResult: Bundle): number {
  const pageSize = search.count ?? DEFAULT_SEARCH_COUNT;
  const total = getTotal(search, lastResult);
  return Math.ceil(total / pageSize);
}

function getStart(search: SearchRequest, lastResult: Bundle): number {
  return Math.min(getTotal(search, lastResult), (search.offset ?? 0) + 1);
}

function getEnd(search: SearchRequest, lastResult: Bundle): number {
  return Math.max(getStart(search, lastResult) + (lastResult.entry?.length ?? 0) - 1, 0);
}

function getTotal(search: SearchRequest, lastResult: Bundle): number {
  let total = lastResult.total;
  if (total === undefined) {
    // If the total is not specified, then we have to estimate it
    total =
      (search.offset ?? 0) +
      (lastResult.entry?.length ?? 0) +
      (lastResult.link?.some((l) => l.relation === 'next') ? 1 : 0);
  }
  return total;
}
