// Per-payment platform fee, stepped down as a business's successful payment count
// for the current calendar month grows. `count` is 1-indexed (the Nth successful
// payment this month), so tier boundaries read the same way they're documented.
const TIERS = [
  { upTo: 100, feeAmount: 0.50 },
  { upTo: 300, feeAmount: 0.45 },
  { upTo: 500, feeAmount: 0.40 },
  { upTo: 1000, feeAmount: 0.35 },
  { upTo: Infinity, feeAmount: 0.30 },
];

function feeForCount(count) {
  const tier = TIERS.find(item => count <= item.upTo);
  return tier.feeAmount;
}

module.exports = { TIERS, feeForCount };
