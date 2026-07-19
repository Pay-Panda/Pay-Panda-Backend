const { feeForCount } = require('../src/lib/feeTiers');

describe('feeForCount (subscription fee tier schedule)', () => {
  test('first payment of the month is the top tier', () => {
    expect(feeForCount(1)).toBe(0.50);
  });

  test('tier boundary at 100 is still the top tier', () => {
    expect(feeForCount(100)).toBe(0.50);
  });

  test('101st payment drops to the next tier', () => {
    expect(feeForCount(101)).toBe(0.45);
  });

  test('tier boundary at 300', () => {
    expect(feeForCount(300)).toBe(0.45);
    expect(feeForCount(301)).toBe(0.40);
  });

  test('tier boundary at 500', () => {
    expect(feeForCount(500)).toBe(0.40);
    expect(feeForCount(501)).toBe(0.35);
  });

  test('tier boundary at 1000', () => {
    expect(feeForCount(1000)).toBe(0.35);
    expect(feeForCount(1001)).toBe(0.30);
  });

  test('very high volume stays at the floor tier', () => {
    expect(feeForCount(50000)).toBe(0.30);
  });
});
