// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { render } from '../test-utils/render';
import { Loading } from './Loading';

/**
 * Returns the names of the inline CSS declarations emitted on an element, in declaration order.
 * @param element - The element to inspect.
 * @returns The inline CSS property names.
 */
function inlineDeclarations(element: HTMLElement): string[] {
  return Array.from({ length: element.style.length }, (_ignored, index) => element.style.item(index));
}

describe('Loading', () => {
  test('Renders', () => {
    const { container } = render(<Loading />);
    expect(container).toBeDefined();
    expect(container.querySelector('[class*="Loader"]')).toBeDefined();
  });

  test('Centers the loader in its wrapper', () => {
    const { container } = render(<Loading />);
    const loader = container.querySelector('.mantine-Loader-root') as HTMLElement;
    expect(loader).toBeInstanceOf(HTMLElement);

    const wrapper = loader.parentElement as HTMLElement;
    expect(wrapper.className).toContain('mantine-Center-root');
    expect(wrapper.childElementCount).toBe(1);
  });

  test('Fills its container without imposing viewport height', () => {
    const { container } = render(<Loading />);
    const wrapper = container.querySelector('.mantine-Center-root') as HTMLElement;
    expect(wrapper).toBeInstanceOf(HTMLElement);

    expect(wrapper.style.width).toBe('100%');
    expect(wrapper.style.height).toBe('100%');
    expect(wrapper.style.minHeight).toBe('inherit');
  });

  test('Emits only container relative geometry', () => {
    const { container } = render(<Loading />);
    const wrapper = container.querySelector('.mantine-Center-root') as HTMLElement;

    expect(inlineDeclarations(wrapper).sort()).toStrictEqual(['height', 'min-height', 'width']);
    for (const declaration of inlineDeclarations(wrapper)) {
      expect(wrapper.style.getPropertyValue(declaration)).not.toMatch(/\d\s*(vh|vw|dvh|dvw|px|rem|em)\b/);
    }
  });
});
