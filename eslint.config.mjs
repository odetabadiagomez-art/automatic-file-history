import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['out/**', 'dist/**', 'node_modules/**', '.vscode-test/**', 'coverage/**']
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
			globals: {
				process: 'readonly',
				console: 'readonly',
				setTimeout: 'readonly',
				clearTimeout: 'readonly',
				setInterval: 'readonly',
				clearInterval: 'readonly',
				Buffer: 'readonly',
				__dirname: 'readonly',
				NodeJS: 'readonly',
				TextDecoder: 'readonly'
			}
		},
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			'@typescript-eslint/explicit-function-return-type': 'off',
			'@typescript-eslint/no-explicit-any': 'warn',
			'no-console': ['warn', { allow: ['warn', 'error'] }],
			eqeqeq: ['error', 'always', { null: 'ignore' }]
		}
	},
	{
		files: ['test/**/*.ts'],
		rules: {
			'@typescript-eslint/no-non-null-assertion': 'off',
			'no-console': 'off'
		}
	}
);
