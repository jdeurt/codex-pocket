"use client";
import { useMemo } from "react";

/** Bind explicit inputs to a module-scope callback implementation.
@param callback - Complete implementation with explicit inputs first.
@param inputs - Values fixed for this callback identity.
@returns Callback accepting the remaining framework arguments.
*/
function bindCallback<Inputs extends unknown[], Args extends unknown[], Result>(
  callback: (...args: [...Inputs, ...Args]) => Result,
  inputs: Inputs
): (...args: Args) => Result {
  return callback.bind(undefined, ...inputs);
}

/** Retain a framework callback until its implementation or explicit inputs change.
@param callback - Module-scope implementation.
@param inputs - Explicit dependencies bound before framework-provided arguments.
@returns Stable callback with complete dependency tracking.
*/
export function useBoundCallback<Inputs extends unknown[], Args extends unknown[], Result>(
  callback: (...args: [...Inputs, ...Args]) => Result,
  ...inputs: Inputs
): (...args: Args) => Result {
  return useMemo((bindCallback<Inputs, Args, Result>).bind(undefined, callback, inputs), [callback, ...inputs]);
}

/** Memoize a pure projection using all its explicit inputs as dependencies.
@param project - Module-scope pure projection.
@param inputs - Complete projection inputs.
@returns The projection value, retained while its inputs are unchanged.
*/
export function useDerivedValue<Inputs extends unknown[], Result>(
  project: (...inputs: Inputs) => Result,
  ...inputs: Inputs
): Result {
  return useMemo(bindCallback<Inputs, [], Result>(project, inputs), [project, ...inputs]);
}
