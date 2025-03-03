import {
  Bool,
  Character,
  Provable,
  CircuitString,
  Field,
  shutdown,
  isReady,
} from 'o1js';

describe('Circuit String', () => {
  beforeEach(() => isReady);
  afterAll(() => setTimeout(shutdown, 0));

  describe('#equals', () => {
    test('returns true when values are equal', () => {
      const str = CircuitString.fromString(
        'Everything we hear is an opinion, not a fact. Everything we see is a perspective, not the truth'
      );
      const same_str = CircuitString.fromString(
        'Everything we hear is an opinion, not a fact. Everything we see is a perspective, not the truth'
      );
      expect(str.equals(same_str)).toEqual(Bool(true));

      Provable.runAndCheckSync(() => {
        const str = CircuitString.fromString(
          'Everything we hear is an opinion, not a fact. Everything we see is a perspective, not the truth'
        );
        const same_str = CircuitString.fromString(
          'Everything we hear is an opinion, not a fact. Everything we see is a perspective, not the truth'
        );
        expect(str.equals(same_str)).toEqual(Bool(true));
      });
    });

    test('returns false when values are not equal', () => {
      const str = CircuitString.fromString('Your size');
      const not_same_str = CircuitString.fromString('size');
      expect(str.equals(not_same_str)).toEqual(Bool(false));

      Provable.runAndCheckSync(() => {
        const str = Provable.witness(CircuitString, () => {
          return CircuitString.fromString('Your size');
        });
        const not_same_str = Provable.witness(CircuitString, () => {
          return CircuitString.fromString('size');
        });
        Provable.asProver(() => {
          expect(str.equals(not_same_str).toBoolean()).toEqual(false);
        });
      });
    });
  });

  /*   describe('#contains', () => {
    test('returns true when str contains other str', () => {
      const str = CircuitString.fromString(
        'Everything we hear is an opinion, not a fact. Everything we see is a perspective, not the truth'
      );
      const contained_str = CircuitString.fromString(
        'Everything we hear is an opinion, not a fact.'
      );
      expect(str.contains(contained_str)).toEqual(new Bool(true));

      Provable.runAndCheckSync(() => {
        const str = CircuitString.fromString(
          'Everything we hear is an opinion, not a fact. Everything we see is a perspective, not the truth'
        );
        const contained_str = CircuitString.fromString(
          'Everything we hear is an opinion, not a fact.'
        );
        expect(str.contains(contained_str)).toEqual(new Bool(true));
      });
    });

    test('returns false when str does not contain other str', () => {
      const str = CircuitString.fromString('abcdefghijklmnop');
      const not_contained_str = CircuitString.fromString('defhij');
      expect(str.contains(not_contained_str)).toEqual(new Bool(false));

      Provable.runAndCheckSync(() => {
        const str = CircuitString.fromString('abcdefghijklmnop');
        const not_contained_str = CircuitString.fromString('defhij');
        expect(str.contains(not_contained_str)).toEqual(new Bool(false));
      });
    });

    describe('compatibility with implementing classes', () => {
      test('string8 may contain string', () => {
        const str = CircuitString8.fromString('abcd');
        const contained_str = CircuitString.fromString('ab');
        expect(str.contains(contained_str)).toEqual(new Bool(true));

        Provable.runAndCheckSync(() => {
          const str = CircuitString8.fromString('abcd');
          const contained_str = CircuitString.fromString('ab');
          expect(str.contains(contained_str)).toEqual(new Bool(true));
        });
      });

      test('string may contain string8', () => {
        const str = CircuitString.fromString('abcd');
        const contained_str = CircuitString8.fromString('ab');
        expect(str.contains(contained_str)).toEqual(new Bool(true));

        Provable.runAndCheckSync(() => {
          const str = CircuitString.fromString('abcd');
          const contained_str = CircuitString8.fromString('ab');
          expect(str.contains(contained_str)).toEqual(new Bool(true));
        });
      });
    });
  }); */

  describe('#toString', () => {
    test('serializes to string', () => {
      const js_str =
        'Everything we hear is an opinion, not a fact. Everything we see is a perspective, not the truth';
      const str = CircuitString.fromString(js_str);
      expect(str.toString()).toBe(js_str);

      Provable.runAndCheckSync(() => {
        const js_str =
          'Everything we hear is an opinion, not a fact. Everything we see is a perspective, not the truth';
        const str = CircuitString.fromString(js_str);
        expect(str.toString()).toBe(js_str);
      });
    });
  });

  describe('#substring', () => {
    test('selects substring', () => {
      const str = CircuitString.fromString(
        'Everything we hear is an opinion, not a fact. Everything we see is a perspective, not the truth'
      );
      expect(str.substring(46, 80).toString()).toBe(
        'Everything we see is a perspective'
      );

      Provable.runAndCheckSync(() => {
        const str = CircuitString.fromString(
          'Everything we hear is an opinion, not a fact. Everything we see is a perspective, not the truth'
        );
        expect(str.substring(46, 80).toString()).toBe(
          'Everything we see is a perspective'
        );
      });
    });
  });

  describe('#append', () => {
    test('appends 2 strings', () => {
      const str1 = CircuitString.fromString('abcd');
      const str2 = CircuitString.fromString('efgh');
      expect(str1.append(str2).toString()).toBe('abcdefgh');

      Provable.runAndCheckSync(() => {
        const str1 = CircuitString.fromString('abcd');
        const str2 = CircuitString.fromString('efgh');
        expect(str1.append(str2).toString()).toBe('abcdefgh');
      });
    });
  });

  /*   describe('CircuitString8', () => {
    test('cannot create more than 8 chars', () => {
      expect(() => {
        Provable.runAndCheckSync(() => {
          Provable.witness(CircuitString8, () => {
            return CircuitString8.fromString('More than eight chars');
          });
        });
      }).toThrow();
    });
  }); */

  describe('with invalid input', () => {
    test.skip('cannot use a character out of range', () => {
      expect(() => {
        Provable.runAndCheckSync(() => {
          const str = Provable.witness(CircuitString, () => {
            return CircuitString.fromCharacters([
              new Character(Field(100)),
              new Character(Field(10000)),
              new Character(Field(100)),
            ]);
          });
        });
      }).toThrow();
    });
  });
});
