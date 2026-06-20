import { describe, expect, it } from '@jest/globals';
import { parseTemplateLimit } from './whatsappTemplate.controller';

describe('parseTemplateLimit', () => {
  it.each([
    [undefined, undefined],
    ['1', 1],
    ['100', 100],
    ['0', undefined],
    ['101', undefined],
    ['1.5', undefined],
    ['invalid', undefined],
    [1, undefined],
    [['1'], undefined]
  ])('parses %p as %p', (value, expected) => {
    expect(parseTemplateLimit(value)).toBe(expected);
  });
});
