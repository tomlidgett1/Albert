import assert from "node:assert/strict";
import test from "node:test";

import type { GovernedResult } from "../../packages/agent/src/semantic-tools.js";
import {
  renderValidatedClaims,
  validateEvidenceClaims,
  type EvidenceClaim,
} from "../../services/conversation/src/claims.js";
import {
  assertObservationGateClear,
  buildGroundedObservation,
  commitPendingObservation,
  createObservationGate,
  markObservationPending,
  validatePendingObservation,
} from "../../services/conversation/src/live.js";

const result = governedResult({
  resultId: "semantic:category-performance",
  columns: [
    { key: "product.category", label: "Product category", type: "string" as const },
    { key: "net_sales", label: "Net sales", type: "currency" as const, currency: "AUD" },
    { key: "gross_margin", label: "Gross margin", type: "percent" as const },
  ],
  rows: [
    { "product.category": "Bikes", net_sales: "100.0000", gross_margin: "20.0000" },
    { "product.category": "Workshop", net_sales: "20.0000", gross_margin: "100.0000" },
  ],
});
const results = new Map([[result.resultId,result]]);

test("structured claims reject swapped row/metric associations", () => {
  const validation = validateEvidenceClaims([claim({
    statement: "Product category Bikes recorded Net sales of $20.",
    assertion: "value",
    refs: [ref(0,"product.category"),ref(0,"net_sales")],
  })],results);
  assert.equal(validation.valid,false);
  assert.ok(validation.errors.some((error) => /unreferenced_number|cell_value_missing/u.test(error)));
});

test("interstitial observations reject unsupported figures and free-form continuations", () => {
  assert.throws(() => buildGroundedObservation({
    claim: {
      statement: "Product category Bikes had Net sales of $9999.",
      assertion: "value",
      refs: [ref(0,"product.category"),ref(0,"net_sales")],
    },
    nextStep: "prepare_answer",
  }, results), /Observation evidence was rejected/u);

  assert.throws(() => buildGroundedObservation({
    claim: {
      statement: "Product category Bikes had Net sales of $100.",
      assertion: "value",
      refs: [ref(0,"product.category"),ref(0,"net_sales")],
    },
    nextStep: "investigate_the_9999_gap",
  } as never, results));
});

test("the observation gate enforces table-observation-artifact order and rejects duplicates", () => {
  const grounded = buildGroundedObservation({
    claim: {
      statement: "Product category Bikes had Net sales of $100.",
      assertion: "value",
      refs: [ref(0,"product.category"),ref(0,"net_sales")],
    },
    nextStep: "visualise_result",
  }, results);
  const gate = createObservationGate();
  markObservationPending(gate, result.resultId);
  assert.throws(() => assertObservationGateClear(gate), /before creating another analytical artifact/u);
  assert.throws(() => validatePendingObservation(gate, {
    ...grounded.claim,
    refs: grounded.claim.refs.map((item) => ({ ...item, resultId: "semantic:older-result" })),
  }), /immediately preceding governed table/u);

  const key = validatePendingObservation(gate, grounded.claim);
  commitPendingObservation(gate, key);
  assert.doesNotThrow(() => assertObservationGateClear(gate));

  markObservationPending(gate, result.resultId);
  assert.throws(
    () => validatePendingObservation(gate, grounded.claim),
    /already been published/u,
  );
});

test("structured claims reject false rankings over the full result", () => {
  const validation = validateEvidenceClaims([claim({
    statement: "Product category Bikes had the highest Gross margin at 20%.",
    assertion: "highest",
    refs: [ref(0,"product.category"),ref(0,"gross_margin")],
  })],results);
  assert.equal(validation.valid,false);
  assert.ok(validation.errors.includes("claim_0:rank_not_supported"));
});

test("global rank claims require compiler-owned ordering before the result limit", () => {
  const limitedRows = [{ "product.category": "Bikes", net_sales: "100.0000", gross_margin: "20.0000" }];
  const withoutProof = governedResult({
    resultId: "semantic:limited-without-proof",
    columns: result.columns,
    rows: limitedRows,
  });
  const statement = "Product category Bikes had the highest Net sales at $100.";
  const rankClaim = (resultId: string): EvidenceClaim => ({
    statement,
    assertion: "highest",
    refs: [
      { resultId,rowIndex: 0,columnKey: "product.category" },
      { resultId,rowIndex: 0,columnKey: "net_sales" },
    ],
  });
  const unproved = validateEvidenceClaims(
    [rankClaim(withoutProof.resultId)],
    new Map([[withoutProof.resultId,withoutProof]]),
  );
  assert.equal(unproved.valid,false);
  assert.ok(unproved.errors.includes("claim_0:rank_not_supported"));

  const proved = governedResult({
    resultId: "semantic:limited-with-global-proof",
    columns: result.columns,
    rows: limitedRows,
    resultWindow: {
      requestedLimit: 1,
      orderedBeforeLimit: true,
      orderBy: [{ columnKey: "net_sales",direction: "desc" }],
    },
  });
  const accepted = validateEvidenceClaims(
    [rankClaim(proved.resultId)],
    new Map([[proved.resultId,proved]]),
  );
  assert.equal(accepted.valid,true,accepted.errors.join(","));

  const wrongDirection = governedResult({
    ...proved,
    resultId: "semantic:limited-wrong-order",
    resultWindow: { ...proved.resultWindow!,orderBy: [{ columnKey: "net_sales",direction: "asc" }] },
  });
  const rejected = validateEvidenceClaims(
    [rankClaim(wrongDirection.resultId)],
    new Map([[wrongDirection.resultId,wrongDirection]]),
  );
  assert.equal(rejected.valid,false);
  assert.ok(rejected.errors.includes("claim_0:rank_not_supported"));
});

test("structured claims validate exact decimal comparisons and dotted dimension keys", () => {
  const validation = validateEvidenceClaims([claim({
    statement: "Product category Bikes Net sales of $100 was higher than Product category Workshop Net sales of $20.",
    assertion: "greater_than",
    refs: [
      ref(0,"product.category"),ref(0,"net_sales"),
      ref(1,"product.category"),ref(1,"net_sales"),
    ],
  })],results);
  assert.equal(validation.valid,true,validation.errors.join(","));
  assert.match(renderValidatedClaims(validation.claims),/Bikes[\s\S]*Workshop/u);
});

test("plain value claims cannot smuggle comparison wording or unreferenced labels", () => {
  const comparative = validateEvidenceClaims([claim({
    statement: "Product category Bikes Net sales of $100 was higher.",
    assertion: "value",
    refs: [ref(0,"product.category"),ref(0,"net_sales")],
  })],results);
  assert.ok(comparative.errors.includes("claim_0:comparison_requires_typed_assertion"));

  const wrongLabel = validateEvidenceClaims([claim({
    statement: "Product category Workshop had Net sales of $100.",
    assertion: "value",
    refs: [ref(0,"product.category"),ref(0,"net_sales")],
  })],results);
  assert.equal(wrongLabel.valid,false);
  assert.ok(wrongLabel.errors.some((error) => /source_label_missing|unreferenced_source_label/u.test(error)));
});

test("comparisons require the exact same governed metric", () => {
  const validation = validateEvidenceClaims([claim({
    statement: "Product category Bikes Net sales of $100 was equal to Product category Workshop Gross margin of 100%.",
    assertion: "equal",
    refs: [
      ref(0,"product.category"),ref(0,"net_sales"),
      ref(1,"product.category"),ref(1,"gross_margin"),
    ],
  })],results);

  assert.equal(validation.valid,false);
  assert.ok(validation.errors.includes("claim_0:comparison_metric_mismatch"));
});

test("comparisons cannot join cells from separate governed results", () => {
  const second = governedResult({
    resultId: "semantic:second-result",
    columns: result.columns,
    rows: result.rows,
  });
  const validation = validateEvidenceClaims([claim({
    statement: "Product category Bikes Net sales of $100 was higher than Product category Workshop Net sales of $20.",
    assertion: "greater_than",
    refs: [
      ref(0,"product.category"),ref(0,"net_sales"),
      { resultId: second.resultId,rowIndex: 1,columnKey: "product.category" },
      { resultId: second.resultId,rowIndex: 1,columnKey: "net_sales" },
    ],
  })],new Map([[result.resultId,result],[second.resultId,second]]));

  assert.equal(validation.valid,false);
  assert.ok(validation.errors.includes("claim_0:cross_result_comparison"));
});

test("value assertions bind exactly one numeric cell and reject extra off-row labels", () => {
  const twoValues = validateEvidenceClaims([claim({
    statement: "Product category Bikes Net sales of $100 and Gross margin of 20%.",
    assertion: "value",
    refs: [ref(0,"product.category"),ref(0,"net_sales"),ref(0,"gross_margin")],
  })],results);
  assert.equal(twoValues.valid,false);
  assert.ok(twoValues.errors.includes("claim_0:value_requires_one_numeric_ref"));

  const offRowLabel = validateEvidenceClaims([claim({
    statement: "Product category Bikes Product category Workshop Net sales of $100.",
    assertion: "value",
    refs: [ref(0,"product.category"),ref(1,"product.category"),ref(0,"net_sales")],
  })],results);
  assert.equal(offRowLabel.valid,false);
  assert.ok(offRowLabel.errors.includes("claim_0:off_row_label_ref"));
});

test("change and difference language requires a typed comparison assertion", () => {
  for (const wording of ["difference", "delta", "gap", "rose", "declined", "double", "versus"]) {
    const validation = validateEvidenceClaims([claim({
      statement: `Product category Bikes Net sales of $100 ${wording}.`,
      assertion: "value",
      refs: [ref(0,"product.category"),ref(0,"net_sales")],
    })],results);
    assert.equal(validation.valid,false,wording);
    assert.ok(validation.errors.includes("claim_0:comparison_requires_typed_assertion"),wording);
  }
});

function ref(rowIndex:number,columnKey:string){
  return{resultId:result.resultId,rowIndex,columnKey};
}

function claim(value:EvidenceClaim):EvidenceClaim{return value;}

function governedResult(
  input: Pick<GovernedResult,"resultId"|"columns"|"rows"> & Partial<Pick<GovernedResult,"resultWindow">>,
):GovernedResult{
  return{
    ...input,
    provenance:{
      sources:[],
      timeRange:{label:"Fixture",start:"2026-07-01T00:00:00.000Z",end:"2026-08-01T00:00:00.000Z",timezone:"Australia/Melbourne"},
      definitions:[],
      semanticBundleHash:"a".repeat(64),
      identityGraph:{version:0,hash:"d41d8cd98f00b204e9800998ecf8427e"},
    },
    validations:[],
  };
}
