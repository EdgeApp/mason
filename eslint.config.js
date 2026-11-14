import tseslint from 'typescript-eslint'
export default tseslint.config(...tseslint.configs.recommended, {
  files: ['src/**/*.ts', 'src/**/*.tsx'],
  rules: {
    '@typescript-eslint/explicit-function-return-type': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
})
