// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { SearchRequest } from '@medplum/core';
import { Operator } from '@medplum/core';
import type { Bundle, Patient, Resource } from '@medplum/fhirtypes';
import { HomerSimpson, MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react-hooks';
import { act, fireEvent, render, screen } from '../test-utils/render';
import type { SearchControlProps } from './SearchControl';
import { SearchControl } from './SearchControl';

describe('SearchControl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
  });

  async function setup(
    props: SearchControlProps,
    returnVal?: Bundle,
    medplum: MockClient = new MockClient()
  ): Promise<{ rerender: (props: SearchControlProps) => Promise<void> }> {
    if (returnVal) {
      medplum.search = vi.fn().mockResolvedValue(returnVal);
    }
    const { rerender: _rerender } = await act(async () =>
      render(<SearchControl {...props} />, ({ children }) => (
        <MedplumProvider medplum={medplum}>{children}</MedplumProvider>
      ))
    );
    return {
      rerender: async (props: SearchControlProps) => {
        await act(async () => _rerender(<SearchControl {...props} />));
      },
    };
  }

  test('Renders results', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
        fields: ['id', '_lastUpdated', 'name'],
      },
      onLoad: vi.fn(),
    };

    await setup(props);

    expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();

    expect(props.onLoad).toHaveBeenCalled();
    expect(screen.getByText('Homer Simpson')).toBeInTheDocument();
  });

  test('Renders additional columns', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        fields: ['id', 'name'],
      },
      additionalColumns: [
        {
          name: 'Custom Column',
          renderCell: (resource) => <span>cell-{resource.id}</span>,
        },
      ],
    };

    await setup(props);

    expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();
    // The additional column header and a computed cell for the row are rendered.
    expect(screen.getByText('Custom Column')).toBeInTheDocument();
    expect(screen.getByText(`cell-${HomerSimpson.id}`)).toBeInTheDocument();
  });

  test('Rerender does not trigger `loadResult` when `search` deep equals `memoizedSearch`', async () => {
    const search = {
      resourceType: 'Patient',
      filters: [
        {
          code: 'name',
          operator: Operator.EQUALS,
          value: 'Simpson',
        },
      ],
      fields: ['id', '_lastUpdated', 'name'],
    } as SearchRequest;

    const props = {
      search,
      onLoad: vi.fn(),
    };

    const { rerender } = await setup(props);

    expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();

    expect(props.onLoad).toHaveBeenCalled();
    expect(screen.getByText('Homer Simpson')).toBeInTheDocument();

    props.onLoad.mockClear();

    await rerender({ ...props, search: { ...search } });
    expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();

    expect(props.onLoad).not.toHaveBeenCalled();
    expect(screen.getByText('Homer Simpson')).toBeInTheDocument();
  });

  test('Rerender triggers `loadResult` when `search` does is not deep equal to `memoizedSearch`', async () => {
    const search = {
      resourceType: 'Patient',
      filters: [
        {
          code: 'name',
          operator: Operator.EQUALS,
          value: 'Simpson',
        },
      ],
      fields: ['id', '_lastUpdated', 'name'],
    } as SearchRequest;

    const props = {
      search,
      onLoad: vi.fn(),
    };

    const { rerender } = await setup(props);

    expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();

    expect(props.onLoad).toHaveBeenCalled();
    expect(screen.getByText('Homer Simpson')).toBeInTheDocument();

    const searchesToTest = [
      {
        ...search,
        fields: ['id', 'name'],
      },
      {
        ...search,
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Homer',
          },
        ],
      },
    ];

    for (const search of searchesToTest) {
      props.onLoad.mockClear();

      await rerender({ ...props, search });
      expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();

      expect(props.onLoad).toHaveBeenCalled();
      expect(screen.getByText('Homer Simpson')).toBeInTheDocument();
    }
  });

  test('Renders _lastUpdated filter', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: '_lastUpdated',
            operator: Operator.GREATER_THAN_OR_EQUALS,
            value: '2021-12-01T00:00:00.000Z',
          },
        ],
        fields: ['id', '_lastUpdated', 'name'],
      },
      onLoad: vi.fn(),
    };

    await setup(props);

    expect(await screen.findByTestId('search-control')).toBeInTheDocument();

    expect(screen.getByText('greater than or equals', { exact: false })).toBeInTheDocument();
  });

  test('Renders empty results', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'this-does-not-exist',
          },
        ],
      },
      onLoad: vi.fn(),
    };

    await setup(props);
    expect(await screen.findByText('No results')).toBeInTheDocument();
    expect(props.onLoad).toHaveBeenCalled();
  });

  test('Renders choice of type', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Observation',
        fields: ['value[x]'],
      },
      onLoad: vi.fn(),
    };

    await setup(props);
    expect(await screen.findByTestId('search-control')).toBeInTheDocument();
    expect(props.onLoad).toHaveBeenCalled();
    expect(screen.getByText('30 x')).toBeInTheDocument();
  });

  test('Renders with checkboxes', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
        fields: ['id', '_lastUpdated', 'name'],
      },
      onLoad: vi.fn(),
      checkboxesEnabled: true,
    };

    await setup(props);
    expect(await screen.findByTestId('search-control')).toBeInTheDocument();
    expect(props.onLoad).toHaveBeenCalled();
  });

  test('Renders empty results with checkboxes', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'this-does-not-exist',
          },
        ],
      },
      onLoad: vi.fn(),
      checkboxesEnabled: true,
    };

    await setup(props);
    expect(await screen.findByText('No results')).toBeInTheDocument();
    expect(props.onLoad).toHaveBeenCalled();
  });

  test('Renders search parameter columns', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        fields: ['id', '_lastUpdated', 'name', 'birthDate', 'active', 'email', 'phone'],
      },
      onLoad: vi.fn(),
    };

    await setup(props);
    expect(await screen.findByTestId('search-control')).toBeInTheDocument();
    expect(props.onLoad).toHaveBeenCalled();
    expect(screen.getByText('chunkylover53@aol.com [home email]')).toBeInTheDocument();
    expect(screen.getByText('555-7334 [home phone]')).toBeInTheDocument();
  });

  test('Renders nested properties', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        fields: ['id', '_lastUpdated', 'name', 'address-city', 'address-state'],
      },
      onLoad: vi.fn(),
    };

    await setup(props);
    expect(await screen.findByTestId('search-control')).toBeInTheDocument();
    expect(props.onLoad).toHaveBeenCalled();
    expect(screen.getByText('Springfield')).toBeInTheDocument();
    expect(screen.getByText('IL')).toBeInTheDocument();
  });

  test('Renders filters', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        fields: ['id', 'name'],
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
      },
      onLoad: vi.fn(),
    };

    await setup(props);
    expect(await screen.findByTestId('search-control')).toBeInTheDocument();
    expect(props.onLoad).toHaveBeenCalled();
  });

  test('Next page button', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        count: 1,
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
      },
      onChange: vi.fn(),
    };

    await setup(props);

    expect(await screen.findByLabelText('Next page')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Next page'));
    });

    expect(props.onChange).toHaveBeenCalled();
  });

  test('Next page button without onChange listener', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        count: 1,
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
      },
    };

    await setup(props);

    expect(await screen.findByLabelText('Next page')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Next page'));
    });
  });

  test('Prev page button', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        count: 1,
        offset: 1,
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
      },
      onChange: vi.fn(),
    };

    await setup(props);

    expect(await screen.findByLabelText('Previous page')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Previous page'));
    });

    expect(props.onChange).toHaveBeenCalled();
  });

  test('New button', async () => {
    const onNew = vi.fn();

    await setup({
      search: {
        resourceType: 'Patient',
      },
      onNew,
    });

    expect(await screen.findByText('New...')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('New...'));
    });

    expect(onNew).toHaveBeenCalled();
  });

  test('Export button', async () => {
    const onExportCsv = vi.fn();

    await setup({
      search: {
        resourceType: 'Patient',
      },
      onExportCsv,
    });

    expect(await screen.findByText('Export...')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Export...'));
    });

    expect(await screen.findByText('Export as CSV')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Export as CSV'));
    });
  });

  test('Delete button', async () => {
    const onDelete = vi.fn();

    await setup({
      search: {
        resourceType: 'Patient',
      },
      onDelete,
    });

    expect(await screen.findByText('Delete...')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Delete...'));
    });

    expect(onDelete).toHaveBeenCalled();
  });

  test('Bulk button', async () => {
    const onBulk = vi.fn();

    await setup({
      search: {
        resourceType: 'Patient',
      },
      onBulk,
    });

    expect(await screen.findByText('Bulk...')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Bulk...'));
    });

    expect(onBulk).toHaveBeenCalled();
  });

  test('Click on row', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
      },
      onClick: vi.fn(),
      onAuxClick: vi.fn(),
    };

    await setup(props);

    expect(await screen.findByTestId('search-control')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getAllByTestId('search-control-row')[0]);
    });

    expect(props.onClick).toHaveBeenCalled();
    expect(props.onAuxClick).not.toHaveBeenCalled();
  });

  test('Aux click on row', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
      },
      onClick: vi.fn(),
      onAuxClick: vi.fn(),
    };

    await setup(props);

    expect(await screen.findByTestId('search-control')).toBeInTheDocument();

    // Test response to middle mouse button
    await act(async () => {
      const rows = screen.getAllByTestId('search-control-row');
      fireEvent.click(rows[0], { button: 1 });
    });

    expect(props.onClick).not.toHaveBeenCalled();
    expect(props.onAuxClick).toHaveBeenCalled();

    // Test response to CMD key (MacOS)
    await act(async () => {
      const rows = screen.getAllByTestId('search-control-row');
      fireEvent.click(rows[0], { metaKey: true });
    });

    expect(props.onClick).not.toHaveBeenCalled();
    expect(props.onAuxClick).toHaveBeenCalledTimes(2);

    // Test response to Ctrl key (Windows)
    await act(async () => {
      const rows = screen.getAllByTestId('search-control-row');
      fireEvent.click(rows[0], { ctrlKey: true });
    });

    expect(props.onClick).not.toHaveBeenCalled();
    expect(props.onAuxClick).toHaveBeenCalledTimes(3);
  });

  test('Field editor onOk', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
      },
      onLoad: vi.fn(),
    };

    await setup(props);

    expect(await screen.findByTestId('search-control')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Fields'));
    });

    expect(await screen.findByText('OK')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('OK'));
    });
  });

  test('Field editor onCancel', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
      },
      onLoad: vi.fn(),
    };

    await setup(props);

    expect(await screen.findByTestId('search-control')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Fields'));
    });

    expect(await screen.findByLabelText('Close')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Close'));
    });
  });

  test('Filter editor onOk', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
      },
      onLoad: vi.fn(),
    };

    await setup(props);

    expect(await screen.findByTestId('search-control')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Filters'));
    });

    expect(await screen.findByText('OK')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('OK'));
    });
  });

  test('Filter editor onCancel', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
      },
      onLoad: vi.fn(),
    };

    await setup(props);

    expect(await screen.findByTestId('search-control')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Filters'));
    });

    expect(await screen.findByLabelText('Close')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Close'));
    });
  });

  test('Popup menu and prompt', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
        fields: ['id', 'name'],
      },
      onLoad: vi.fn(),
    };

    await setup(props);

    expect(await screen.findByTestId('search-control')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Name'));
    });

    const containsButton = await screen.findByText('Contains...');
    await act(async () => {
      fireEvent.click(containsButton);
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Search value'), {
        target: { value: 'Washington' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('OK'));
    });
  });

  test('Click all checkbox', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
      },
      onLoad: vi.fn(),
      checkboxesEnabled: true,
    };

    await setup(props);
    expect(await screen.findByTestId('search-control')).toBeInTheDocument();
    expect(props.onLoad).toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId('all-checkbox'));
    });

    const allCheckbox = screen.getByTestId('all-checkbox');
    expect(allCheckbox).toBeDefined();
    expect((allCheckbox as HTMLInputElement).checked).toEqual(true);

    const rowCheckboxes = screen.queryAllByTestId('row-checkbox');
    expect(rowCheckboxes).toBeDefined();
    expect(rowCheckboxes.length).toEqual(2);
    expect((rowCheckboxes[0] as HTMLInputElement).checked).toEqual(true);
    expect((rowCheckboxes[1] as HTMLInputElement).checked).toEqual(true);
  });

  test('Click row checkbox', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
      },
      onLoad: vi.fn(),
      checkboxesEnabled: true,
    };

    await setup(props);
    expect(await screen.findByTestId('search-control')).toBeInTheDocument();
    expect(props.onLoad).toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getAllByTestId('row-checkbox')[0]);
    });

    await act(async () => {
      fireEvent.click(screen.getAllByTestId('row-checkbox')[1]);
    });

    const allCheckbox = screen.getByTestId('all-checkbox');
    expect(allCheckbox).toBeDefined();
    expect((allCheckbox as HTMLInputElement).checked).toEqual(true);

    const rowCheckboxes = screen.queryAllByTestId('row-checkbox');
    expect(rowCheckboxes).toBeDefined();
    expect(rowCheckboxes.length).toEqual(2);
    expect((rowCheckboxes[0] as HTMLInputElement).checked).toEqual(true);
    expect((rowCheckboxes[1] as HTMLInputElement).checked).toEqual(true);
  });

  test('Activate popup menu', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        fields: ['id', 'name'],
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
      },
      onLoad: vi.fn(),
      checkboxesEnabled: true,
    };

    await setup(props);
    expect(await screen.findByTestId('search-control')).toBeInTheDocument();
    expect(props.onLoad).toHaveBeenCalled();

    // Click on the column header to activate the popup menu
    await act(async () => {
      fireEvent.click(screen.getByText('Name'));
    });

    // Expect the popup menu to be open now
    const sortButton = await screen.findByText('Sort A to Z');
    expect(sortButton).toBeInTheDocument();

    // Click on a sort operation
    await act(async () => {
      fireEvent.click(sortButton);
    });

    // Click on the column header to activate the popup menu
    await act(async () => {
      fireEvent.click(screen.getByText('Name'));
    });
  });

  test('Hide toolbar', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
        fields: ['id', '_lastUpdated', 'name'],
      },
      onLoad: vi.fn(),
      hideToolbar: true,
    };

    await setup(props);
    expect(await screen.findByTestId('search-control')).toBeInTheDocument();
    expect(props.onLoad).toHaveBeenCalled();
    expect(screen.getByText('Homer Simpson')).toBeInTheDocument();
    expect(screen.queryByText('Patient')).not.toBeInTheDocument();
  });

  test('Hide filters', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
        fields: ['id', '_lastUpdated', 'name'],
      },
      onLoad: vi.fn(),
      hideFilters: true,
    };

    await setup(props);
    expect(await screen.findByTestId('search-control')).toBeInTheDocument();
    expect(props.onLoad).toHaveBeenCalled();
    expect(screen.getByText('Homer Simpson')).toBeInTheDocument();
    expect(screen.queryByText('no filters')).not.toBeInTheDocument();
  });

  test('Handle reference missing filter', async () => {
    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        fields: ['id', '_lastUpdated', 'name', 'organization'],
        filters: [
          {
            code: 'organization',
            operator: Operator.MISSING,
            value: 'true',
          },
        ],
      },
      onLoad: vi.fn(),
    };

    await setup(props);

    expect(await screen.findByText('missing true')).toBeInTheDocument();

    expect(screen.getByText('missing true')).toBeInTheDocument();
  });

  test('Refresh results', async () => {
    const onLoad = vi.fn();

    const props: SearchControlProps = {
      search: {
        resourceType: 'Patient',
        filters: [
          {
            code: 'name',
            operator: Operator.EQUALS,
            value: 'Simpson',
          },
        ],
        fields: ['id', '_lastUpdated', 'name'],
      },
      onLoad,
    };

    await setup(props);
    expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();
    expect(onLoad).toHaveBeenCalled();
    onLoad.mockReset();

    const refreshButton = screen.getByTitle('Refresh');
    expect(refreshButton).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(refreshButton);
    });

    expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();
    expect(onLoad).toHaveBeenCalled();
  });

  describe('Pagination', () => {
    const onLoad = vi.fn();
    const search: SearchRequest = {
      resourceType: 'Patient',
      count: 20,
      offset: 0,
      filters: [
        {
          code: 'name',
          operator: Operator.EQUALS,
          value: 'Simpson',
        },
      ],
      fields: ['id', '_lastUpdated', 'name'],
    };
    test('No results', async () => {
      const props: SearchControlProps = {
        search,
        onLoad,
      };
      await setup(props, {
        resourceType: 'Bundle',
        type: 'searchset',
        total: 0,
        entry: [],
      });
      expect(await screen.findByText('No results')).toBeInTheDocument();
      const element = screen.getByTestId('count-display');
      expect(element.textContent).toBe('0-0 of 0');
    });
    test('One result', async () => {
      const props: SearchControlProps = {
        search,
        onLoad,
      };
      await setup(props, {
        resourceType: 'Bundle',
        type: 'searchset',
        total: 1,
        entry: [{ resource: HomerSimpson }],
      });
      expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();
      const element = screen.getByTestId('count-display');
      expect(element.textContent).toBe('1-1 of 1');
    });
    test('Single Page', async () => {
      const props: SearchControlProps = {
        search,
        onLoad,
      };
      await setup(props, {
        resourceType: 'Bundle',
        type: 'searchset',
        total: 5,
        entry: [{ resource: HomerSimpson }, ...Array(4).fill({ resourceType: 'Patient' })],
      });
      expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();
      const element = screen.getByTestId('count-display');
      expect(element.textContent).toBe('1-5 of 5');
    });

    test('Multiple Pages', async () => {
      const props: SearchControlProps = {
        search,
        onLoad,
      };
      await setup(props, {
        resourceType: 'Bundle',
        type: 'searchset',
        total: 40,
        entry: [{ resource: HomerSimpson }, ...Array(19).fill({ resourceType: 'Patient' })],
      });
      expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();
      const element = screen.getByTestId('count-display');
      expect(element.textContent).toBe('1-20 of 40');
    });

    test('Large Estimated Count', async () => {
      const props: SearchControlProps = {
        search,
        onLoad,
      };

      await setup(props, {
        resourceType: 'Bundle',
        type: 'searchset',
        total: 403091,
        entry: [{ resource: HomerSimpson }, ...Array(19).fill({ resourceType: 'Patient' })],
      });
      expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();
      const element = screen.getByTestId('count-display');
      expect(element.textContent).toBe('1-20 of 403,091');
    });

    test('Large Estimated Count w/ High Offset', async () => {
      const props: SearchControlProps = {
        search: { ...search, offset: 200000, count: 20 },
        onLoad,
      };

      await setup(props, {
        resourceType: 'Bundle',
        type: 'searchset',
        total: 403091,
        entry: [{ resource: HomerSimpson }, ...Array(19).fill({ resourceType: 'Patient' })],
        link: [
          {
            relation: 'next',
            url: '',
          },
        ],
      });
      expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();
      expect(screen.getByTestId('count-display').textContent).toBe('200,001-200,020 of 403,091');
    });
  });

  describe('Table accessibility', () => {
    test('Default table accessible name', async () => {
      const props: SearchControlProps = {
        search: {
          resourceType: 'Patient',
          fields: ['id', 'name'],
        },
        onLoad: vi.fn(),
      };

      await setup(props);

      expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();
      expect(screen.getByRole('table', { name: 'Patient search results' })).toBeInTheDocument();
    });

    test('tableAriaLabel overrides the default accessible name', async () => {
      const props: SearchControlProps = {
        search: {
          resourceType: 'Patient',
          fields: ['id', 'name'],
        },
        tableAriaLabel: 'OAuth client security results',
        onLoad: vi.fn(),
      };

      await setup(props);

      expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();
      expect(screen.getByRole('table', { name: 'OAuth client security results' })).toBeInTheDocument();
      expect(screen.queryByRole('table', { name: 'Patient search results' })).not.toBeInTheDocument();
    });

    test('All header cells have scope="col"', async () => {
      const props: SearchControlProps = {
        search: {
          resourceType: 'Patient',
          fields: ['id', 'name'],
        },
        additionalColumns: [
          {
            name: 'Custom Column',
            renderCell: (resource) => <span>cell-{resource.id}</span>,
          },
        ],
        checkboxesEnabled: true,
        onLoad: vi.fn(),
      };

      await setup(props);

      expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();

      const table = screen.getByRole('table', { name: 'Patient search results' });
      const headerCells = Array.from(table.querySelectorAll('thead th'));

      // Two header rows: checkbox + 2 fields + 1 additional column, and the same shape for the filter row.
      expect(headerCells).toHaveLength(8);
      for (const headerCell of headerCells) {
        expect(headerCell).toHaveAttribute('scope', 'col');
      }
    });

    test('aria-sort reflects the sort rules', async () => {
      const props: SearchControlProps = {
        search: {
          resourceType: 'Patient',
          fields: ['name', 'birthDate', 'unknown-field'],
          sortRules: [{ code: 'birthdate', descending: true }],
        },
        onLoad: vi.fn(),
      };

      await setup(props);

      expect(await screen.findByTestId('search-control')).toBeInTheDocument();

      // The sort rule carries the search parameter code ("birthdate"), not the field name ("birthDate").
      expect(screen.getByText('Birth Date').closest('th')).toHaveAttribute('aria-sort', 'descending');
      // Only the sorted column carries aria-sort.
      expect(screen.getByText('Name').closest('th')).not.toHaveAttribute('aria-sort');
      expect(screen.getByText('Unknown Field').closest('th')).not.toHaveAttribute('aria-sort');
    });

    test('aria-sort is ascending for an ascending sort rule', async () => {
      const props: SearchControlProps = {
        search: {
          resourceType: 'Patient',
          fields: ['name', 'birthDate'],
          sortRules: [{ code: 'name' }],
        },
        onLoad: vi.fn(),
      };

      await setup(props);

      expect(await screen.findByTestId('search-control')).toBeInTheDocument();

      expect(screen.getByText('Name').closest('th')).toHaveAttribute('aria-sort', 'ascending');
      expect(screen.getByText('Birth Date').closest('th')).not.toHaveAttribute('aria-sort');
    });
  });

  describe('Pagination accessibility', () => {
    const search: SearchRequest = {
      resourceType: 'Patient',
      count: 20,
      offset: 20,
      fields: ['id', 'name'],
    };

    const multiPageBundle: Bundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      total: 60,
      entry: [{ resource: HomerSimpson }],
    };

    function getEnabledPaginationButtons(): HTMLButtonElement[] {
      const nav = screen.getByRole('navigation', { name: /pagination/i });
      return Array.from(nav.querySelectorAll('button')).filter((button) => !button.disabled);
    }

    test('Pagination is a labelled navigation landmark', async () => {
      await setup({ search, onLoad: vi.fn() }, multiPageBundle);

      expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();

      const nav = screen.getByRole('navigation', { name: 'Patient search results pagination' });
      expect(nav).toBeInTheDocument();
      expect(nav.querySelector('button')).toBeInTheDocument();
    });

    test('Arrow keys move focus between pagination controls', async () => {
      const onChange = vi.fn();
      await setup({ search, onChange, onLoad: vi.fn() }, multiPageBundle);

      expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();

      const buttons = getEnabledPaginationButtons();
      expect(buttons.length).toBeGreaterThan(2);

      act(() => {
        buttons[0].focus();
      });
      expect(document.activeElement).toBe(buttons[0]);

      await act(async () => {
        fireEvent.keyDown(buttons[0], { key: 'ArrowRight' });
      });
      expect(document.activeElement).toBe(buttons[1]);

      await act(async () => {
        fireEvent.keyDown(buttons[1], { key: 'ArrowLeft' });
      });
      expect(document.activeElement).toBe(buttons[0]);

      await act(async () => {
        fireEvent.keyDown(buttons[0], { key: 'End' });
      });
      expect(document.activeElement).toBe(buttons[buttons.length - 1]);

      await act(async () => {
        fireEvent.keyDown(buttons[buttons.length - 1], { key: 'Home' });
      });
      expect(document.activeElement).toBe(buttons[0]);

      // Focus traversal must not change the page.
      expect(onChange).not.toHaveBeenCalled();
    });

    test('Arrow keys at the ends and unrelated keys do not move focus', async () => {
      await setup({ search, onChange: vi.fn(), onLoad: vi.fn() }, multiPageBundle);

      expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();

      const buttons = getEnabledPaginationButtons();
      const lastButton = buttons[buttons.length - 1];

      act(() => {
        buttons[0].focus();
      });

      await act(async () => {
        fireEvent.keyDown(buttons[0], { key: 'ArrowLeft' });
      });
      expect(document.activeElement).toBe(buttons[0]);

      await act(async () => {
        fireEvent.keyDown(buttons[0], { key: 'a' });
      });
      expect(document.activeElement).toBe(buttons[0]);

      await act(async () => {
        fireEvent.keyDown(buttons[0], { key: 'Escape' });
      });
      expect(document.activeElement).toBe(buttons[0]);

      act(() => {
        lastButton.focus();
      });

      await act(async () => {
        fireEvent.keyDown(lastButton, { key: 'ArrowRight' });
      });
      expect(document.activeElement).toBe(lastButton);
    });

    test('Arrow keys do nothing when focus is outside the pagination controls', async () => {
      await setup({ search, onChange: vi.fn(), onLoad: vi.fn() }, multiPageBundle);

      expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();

      const nav = screen.getByRole('navigation', { name: /pagination/i });
      const previousActiveElement = document.activeElement;

      await act(async () => {
        fireEvent.keyDown(nav, { key: 'ArrowRight' });
      });

      expect(document.activeElement).toBe(previousActiveElement);
    });
  });

  describe('Overlapping searches', () => {
    const bartSimpson: Patient = {
      resourceType: 'Patient',
      id: 'bart-simpson',
      name: [{ given: ['Bart'], family: 'Simpson' }],
    };

    function createDeferred(): { promise: Promise<Bundle>; resolve: (value: Bundle) => void } {
      let resolve!: (value: Bundle) => void;
      const promise = new Promise<Bundle>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    function buildBundle(resource: Resource): Bundle {
      return {
        resourceType: 'Bundle',
        type: 'searchset',
        total: 1,
        entry: [{ resource }],
      };
    }

    const firstSearch: SearchRequest = {
      resourceType: 'Patient',
      fields: ['id', 'name'],
      filters: [{ code: 'name', operator: Operator.EQUALS, value: 'Homer' }],
    };

    const secondSearch: SearchRequest = {
      resourceType: 'Patient',
      fields: ['id', 'name'],
      filters: [{ code: 'name', operator: Operator.EQUALS, value: 'Bart' }],
    };

    test('Superseded search response is discarded', async () => {
      const first = createDeferred();
      const second = createDeferred();
      const medplum = new MockClient();
      medplum.search = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

      const onLoad = vi.fn();
      const { rerender } = await setup({ search: firstSearch, onLoad }, undefined, medplum);

      expect(await screen.findByTestId('search-control')).toBeInTheDocument();
      expect(onLoad).not.toHaveBeenCalled();

      // Start the second search before the first one settles.
      await rerender({ search: secondSearch, onLoad });
      expect(medplum.search).toHaveBeenCalledTimes(2);

      // The superseded first response settles last and must be ignored entirely.
      await act(async () => {
        second.resolve(buildBundle(bartSimpson));
      });

      expect(await screen.findByText('Bart Simpson')).toBeInTheDocument();
      expect(onLoad).toHaveBeenCalledTimes(1);

      await act(async () => {
        first.resolve(buildBundle(HomerSimpson));
      });

      expect(screen.queryByText('Homer Simpson')).not.toBeInTheDocument();
      expect(screen.getByText('Bart Simpson')).toBeInTheDocument();
      expect(onLoad).toHaveBeenCalledTimes(1);
      expect(onLoad.mock.calls[0][0].response.entry?.[0]?.resource?.id).toBe('bart-simpson');
    });

    test('Loading row replaces the previous rows while a new search is in flight', async () => {
      const second = createDeferred();
      const medplum = new MockClient();
      medplum.search = vi.fn().mockResolvedValueOnce(buildBundle(HomerSimpson)).mockReturnValueOnce(second.promise);

      const onLoad = vi.fn();
      const props: SearchControlProps = {
        search: firstSearch,
        additionalColumns: [
          {
            name: 'Custom Column',
            renderCell: (resource) => <span>cell-{resource.id}</span>,
          },
        ],
        checkboxesEnabled: true,
        onLoad,
      };

      const { rerender } = await setup(props, undefined, medplum);

      expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();
      expect(screen.getByRole('table', { name: 'Patient search results' })).toHaveAttribute('aria-busy', 'false');

      await rerender({ ...props, search: secondSearch });

      // The previous page's rows are replaced by a single loading row while the new search is in flight.
      const loadingRow = screen.getByTestId('search-control-loading-row');
      expect(loadingRow).toBeInTheDocument();
      expect(loadingRow.querySelector('td')).toHaveAttribute('colspan', '4');
      expect(screen.queryByText('Homer Simpson')).not.toBeInTheDocument();
      expect(screen.queryAllByTestId('search-control-row')).toHaveLength(0);
      expect(screen.queryByText('No results')).not.toBeInTheDocument();
      expect(screen.getByRole('table', { name: 'Patient search results' })).toHaveAttribute('aria-busy', 'true');

      await act(async () => {
        second.resolve(buildBundle(bartSimpson));
      });

      expect(await screen.findByText('Bart Simpson')).toBeInTheDocument();
      expect(screen.queryByTestId('search-control-loading-row')).not.toBeInTheDocument();
      expect(screen.getByRole('table', { name: 'Patient search results' })).toHaveAttribute('aria-busy', 'false');
    });

    test('Loading row suppresses the No results block between searches', async () => {
      const second = createDeferred();
      const medplum = new MockClient();
      const emptyBundle: Bundle = {
        resourceType: 'Bundle',
        type: 'searchset',
        total: 0,
        entry: [],
      };
      medplum.search = vi.fn().mockResolvedValueOnce(emptyBundle).mockReturnValueOnce(second.promise);

      const onLoad = vi.fn();
      const { rerender } = await setup({ search: firstSearch, onLoad }, undefined, medplum);

      expect(await screen.findByText('No results')).toBeInTheDocument();

      await rerender({ search: secondSearch, onLoad });

      expect(screen.getByTestId('search-control-loading-row')).toBeInTheDocument();
      expect(screen.queryByText('No results')).not.toBeInTheDocument();

      await act(async () => {
        second.resolve(buildBundle(bartSimpson));
      });

      expect(await screen.findByText('Bart Simpson')).toBeInTheDocument();
      expect(screen.queryByText('No results')).not.toBeInTheDocument();
    });
  });

  describe('Row region height reservation', () => {
    const rowHeight = 37;
    const pageSize = 20;
    const originalGetBoundingClientRect = HTMLTableSectionElement.prototype.getBoundingClientRect;

    const search: SearchRequest = {
      resourceType: 'Patient',
      count: pageSize,
      offset: 0,
      fields: ['id', 'name'],
    };

    /**
     * Builds a search response page of distinct patients.
     * @param count - The number of entries on the page.
     * @param offset - The offset of the page, which also seeds the entry ids.
     * @param total - The total number of matches across all pages.
     * @returns A searchset Bundle of `count` patients.
     */
    function buildPage(count: number, offset: number, total: number): Bundle {
      return {
        resourceType: 'Bundle',
        type: 'searchset',
        total,
        entry: Array.from({ length: count }, (_unused, index) => ({
          resource: {
            resourceType: 'Patient',
            id: `patient-${offset + index}`,
            name: [{ given: ['Patient'], family: `Number${offset + index}` }],
          },
        })),
      };
    }

    function createDeferred(): { promise: Promise<Bundle>; resolve: (value: Bundle) => void } {
      let resolve!: (value: Bundle) => void;
      const promise = new Promise<Bundle>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    beforeEach(() => {
      // jsdom reports every element as zero-height, so the row region's geometry is stubbed from its rendered rows.
      HTMLTableSectionElement.prototype.getBoundingClientRect = function (this: HTMLTableSectionElement): DOMRect {
        const height = this.rows.length * rowHeight;
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: height,
          width: 0,
          height,
          toJSON: () => ({}),
        };
      };
    });

    afterEach(() => {
      HTMLTableSectionElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    });

    test('Full page reserves no height', async () => {
      const medplum = new MockClient();
      medplum.search = vi.fn().mockResolvedValue(buildPage(pageSize, 0, 27));

      await setup({ search }, undefined, medplum);

      expect(await screen.findAllByTestId('search-control-row')).toHaveLength(pageSize);
      expect(screen.queryByTestId('search-control-row-region-spacer')).not.toBeInTheDocument();
    });

    test('Short last page reserves the missing rows', async () => {
      const medplum = new MockClient();
      medplum.search = vi
        .fn()
        .mockResolvedValueOnce(buildPage(pageSize, 0, 27))
        .mockResolvedValueOnce(buildPage(7, pageSize, 27));

      const { rerender } = await setup({ search }, undefined, medplum);

      expect(await screen.findAllByTestId('search-control-row')).toHaveLength(pageSize);
      expect(screen.queryByTestId('search-control-row-region-spacer')).not.toBeInTheDocument();

      await rerender({ search: { ...search, offset: pageSize } });

      expect(await screen.findAllByTestId('search-control-row')).toHaveLength(7);
      const spacer = screen.getByTestId('search-control-row-region-spacer');
      // The 13 rows the short page does not render: 13 * 37 px.
      expect(spacer.style.height).toBe('481px');
    });

    test('Reservation holds while the next page is in flight', async () => {
      const nextPage = createDeferred();
      const medplum = new MockClient();
      medplum.search = vi
        .fn()
        .mockResolvedValueOnce(buildPage(pageSize, 0, 27))
        .mockReturnValueOnce(nextPage.promise);

      const { rerender } = await setup({ search }, undefined, medplum);

      expect(await screen.findAllByTestId('search-control-row')).toHaveLength(pageSize);

      await rerender({ search: { ...search, offset: pageSize } });

      expect(screen.getByTestId('search-control-loading-row')).toBeInTheDocument();
      // The single loading row measures 37 px, so the remaining 19 rows' worth of height is held.
      expect(screen.getByTestId('search-control-row-region-spacer').style.height).toBe('703px');

      await act(async () => {
        nextPage.resolve(buildPage(7, pageSize, 27));
      });

      expect(await screen.findAllByTestId('search-control-row')).toHaveLength(7);
      expect(screen.getByTestId('search-control-row-region-spacer').style.height).toBe('481px');
    });

    test('Short page reached directly reserves from the rendered rows', async () => {
      const medplum = new MockClient();
      medplum.search = vi.fn().mockResolvedValue(buildPage(7, pageSize, 27));

      await setup({ search: { ...search, offset: pageSize } }, undefined, medplum);

      expect(await screen.findAllByTestId('search-control-row')).toHaveLength(7);
      expect(screen.getByTestId('search-control-row-region-spacer').style.height).toBe('481px');
    });

    test('Single page result set renders no spacer', async () => {
      const medplum = new MockClient();
      medplum.search = vi.fn().mockResolvedValue(buildPage(7, 0, 7));

      await setup({ search }, undefined, medplum);

      expect(await screen.findAllByTestId('search-control-row')).toHaveLength(7);
      expect(screen.queryByTestId('search-control-row-region-spacer')).not.toBeInTheDocument();
      expect(screen.getByRole('navigation', { name: /pagination/i })).toBeInTheDocument();
    });

    test('Spacer is hidden from assistive technology and rendered outside the table', async () => {
      const medplum = new MockClient();
      medplum.search = vi.fn().mockResolvedValue(buildPage(7, pageSize, 27));

      await setup({ search: { ...search, offset: pageSize } }, undefined, medplum);

      expect(await screen.findAllByTestId('search-control-row')).toHaveLength(7);

      const spacer = screen.getByTestId('search-control-row-region-spacer');
      expect(spacer).toHaveAttribute('aria-hidden', 'true');

      const table = screen.getByRole('table', { name: 'Patient search results' });
      expect(table.contains(spacer)).toBe(false);
      expect(table.querySelectorAll('tbody tr')).toHaveLength(7);

      // The reservation sits between the table and the pagination landmark.
      const nav = screen.getByRole('navigation', { name: /pagination/i });
      expect(spacer.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(spacer.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    });
  });
});
