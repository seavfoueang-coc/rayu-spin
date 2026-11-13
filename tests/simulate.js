/*
 * Statistical sanity check + geometry check for js/fairness.js.
 * Run with:  node tests/simulate.js [spins]
 * Needs Node.js 19+ (global Web Crypto). Not needed to run the website.
 */
'use strict';

var path = require('path');
var F = require(path.join(__dirname, '..', 'js', 'fairness.js'));

var N = parseInt(process.argv[2], 10) || 1000000;
var failures = 0;

function check(cond, msg) {
  if (!cond) { failures++; console.error('  FAIL: ' + msg); }
}

console.log('Web Crypto in use: ' + F.usesCrypto);
check(F.usesCrypto, 'crypto.getRandomValues should be available');

/* 1) Uniformity of pickPrizeIndex() -------------------------------------- */
var counts = [0, 0, 0, 0];
for (var i = 0; i < N; i++) counts[F.pickPrizeIndex()]++;

var expected = N / 4;
var chi2 = 0;
console.log('\nPrize selection over ' + N.toLocaleString('en-US') + ' draws:');
counts.forEach(function (c, idx) {
  chi2 += Math.pow(c - expected, 2) / expected;
  console.log('  ' + F.PRIZES[idx].name.padEnd(9) + c.toLocaleString('en-US').padStart(10) +
    '  ' + (100 * c / N).toFixed(3) + '%');
});
// Chi-square with 3 degrees of freedom: 99.9% critical value = 16.27.
console.log('  chi-square (df=3) = ' + chi2.toFixed(3) + '  (fails above 16.27 at p = 0.001)');
check(chi2 < 16.27, 'distribution is not consistent with uniform (chi2=' + chi2 + ')');
counts.forEach(function (c, idx) {
  check(Math.abs(c / N - 0.25) < 0.005, F.PRIZES[idx].name + ' frequency off by more than 0.5 pp');
});

/* 2) Independence: P(next = j | previous = i) should be ~25% for all i, j */
var M = Math.min(N, 400000);
var pair = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
var prev = F.pickPrizeIndex();
for (var k = 0; k < M; k++) {
  var next = F.pickPrizeIndex();
  pair[prev][next]++;
  prev = next;
}
var maxDev = 0;
pair.forEach(function (row) {
  var total = row.reduce(function (a, b) { return a + b; }, 0);
  row.forEach(function (c) { maxDev = Math.max(maxDev, Math.abs(c / total - 0.25)); });
});
console.log('\nConsecutive-spin independence (' + M.toLocaleString('en-US') + ' pairs): max deviation ' +
  (maxDev * 100).toFixed(3) + ' pp from 25%');
check(maxDev < 0.01, 'consecutive results look dependent');

/* 3) Geometry: planned rotation always lands on the chosen segment -------- */
var G = 200000;
var rotation = -45;
var minMargin = Infinity;
var minTurnsSeen = Infinity, maxTurnsSeen = 0;
var mismatches = 0;
var landedCounts = [0, 0, 0, 0];
for (var s = 0; s < G; s++) {
  var idx = F.pickPrizeIndex();
  var plan = F.planSpin(rotation, idx, { minTurns: 6, maxTurns: 8 });
  check(plan.targetRotation > rotation, 'wheel must always move forward');
  var landed = F.segmentIndexAtPointer(plan.targetRotation);
  if (landed !== idx) mismatches++;
  landedCounts[landed]++;
  minMargin = Math.min(minMargin, F.distanceToBoundary(plan.targetRotation));
  var fullTurns = Math.floor(plan.delta / 360);
  minTurnsSeen = Math.min(minTurnsSeen, fullTurns);
  maxTurnsSeen = Math.max(maxTurnsSeen, fullTurns);
  // The app stores rotation mod 360 after each spin; mimic that.
  rotation = F.mod(plan.targetRotation, 360);
  check(F.segmentIndexAtPointer(rotation) === idx, 'normalising rotation changed the result');
}
console.log('\nGeometry over ' + G.toLocaleString('en-US') + ' planned spins:');
console.log('  pointer/result mismatches: ' + mismatches);
console.log('  closest stop to a segment edge: ' + minMargin.toFixed(3) + '°  (required ≥ ' + F.BOUNDARY_MARGIN + '°)');
console.log('  full turns per spin: ' + minTurnsSeen + '–' + maxTurnsSeen);
console.log('  landed counts: ' + landedCounts.join(', '));
check(mismatches === 0, 'pointer and result disagree');
check(minMargin >= F.BOUNDARY_MARGIN - 1e-9, 'stopped too close to a segment edge');

/* 4) Hand-checked geometry cases ----------------------------------------- */
// rotation 0: local angle 0 under pointer -> segment 0 (30%)
check(F.segmentIndexAtPointer(0 - 1) === 0, 'R=-1 should be 30%');
check(F.segmentIndexAtPointer(-45) === 0, 'R=-45 should be 30%');
check(F.segmentIndexAtPointer(-135) === 1, 'R=-135 should be 50%');
check(F.segmentIndexAtPointer(-225) === 2, 'R=-225 should be 70%');
check(F.segmentIndexAtPointer(-315) === 3, 'R=-315 should be 100%');
check(F.segmentIndexAtPointer(45) === 3, 'R=+45 (clockwise) brings 100% under the pointer');
check(F.segmentIndexAtPointer(3600 - 135) === 1, 'large rotations work');

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
