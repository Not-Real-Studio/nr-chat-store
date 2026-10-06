import { configDefaults, defineConfig } from 'vitest/config'

// bench/ — замеры (DEV-237): `BENCH=1 npx vitest run bench`, в общий прогон не входят.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, ...(process.env.BENCH ? [] : ['bench/**'])] },
})
