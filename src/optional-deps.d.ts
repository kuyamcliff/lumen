/**
 * Ambient declarations for optional peer dependencies.
 *
 * These are loaded through dynamic `import()` at runtime and are external
 * in the build, so the player must type-check and build whether or not
 * they're installed. Declaring them here keeps that true without pulling
 * their types into the dependency graph.
 */
declare module "dashjs";
