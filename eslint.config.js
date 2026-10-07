import tseslint from 'typescript-eslint'
export default tseslint.config(...tseslint.configs.recommended, {
  files: ['src/**/*.ts'],
  rules: { '@typescript-eslint/explicit-function-return-type': 'error' },
})
