import { parse, type ParseError } from 'jsonc-parser';

/** Parses JSON and JSONC, including comments and trailing commas. */
export function parseJsonc<T>(contents: string): T {
	const errors: ParseError[] = [];
	const value = parse(contents, errors, { allowTrailingComma: true });

	if (errors.length > 0) {
		const firstError = errors[0];
		throw new SyntaxError(`Invalid JSONC at offset ${firstError.offset}`);
	}

	return value as T;
}
