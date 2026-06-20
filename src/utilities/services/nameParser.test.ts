import { describe, expect, it } from '@jest/globals';
import { splitFullName } from './nameParser';

describe('splitFullName', () => {
  it.each([
    ['', {}],
    ['   ', {}],
    ['Ndoye', { firstName: '', lastName: 'Ndoye' }],
    ['Isadore Ndoye', { firstName: 'Isadore', lastName: 'Ndoye' }],
    ['Isadore Mangala Ndoye', { firstName: 'Isadore Mangala', lastName: 'Ndoye' }],
    ['  Isadore   Mangala   Ndoye  ', { firstName: 'Isadore Mangala', lastName: 'Ndoye' }]
  ])('parses %p', (input, expected) => {
    expect(splitFullName(input)).toEqual(expected);
  });
});
