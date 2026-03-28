/**
 * @atlasreforge/field-registry — Public API
 */

// Main service
export { RegistryService, RegistryError } from './registry.service.js';

// Types
export type {
  BuildSessionInput,
  CompletionBlocker,
  CustomFieldMapping,
  GdprRisk,
  GroupMapping,
  JiraCloudField,
  JiraCloudGroup,
  JiraCloudUser,
  MappingStatus,
  PlaceholderResolutionResult,
  RegistrySession,
  SkipMappingInput,
  UpdateCustomFieldInput,
  UpdateGroupInput,
  UpdateUserInput,
  UserMapping,
  UserResolutionStrategy,
} from './types/registry.types.js';

// Store
export { InMemoryRegistryStore } from './store/registry.store.js';
export type { RegistryStore } from './store/registry.store.js';

// Placeholder resolver (exported for direct use by the API layer)
export {
  resolvePlaceholders,
  resolveAllFiles,
} from './resolvers/placeholder.resolver.js';

// Validator (exported for direct use)
export {
  validateCloudField,
  validateCloudGroup,
  validateCloudAccountId,
  autoMapFieldByName,
  JiraValidationError,
} from './validators/jira-cloud.validator.js';
export type {
  ValidatorConfig,
  FieldValidationResult,
  GroupValidationResult,
  UserValidationResult,
  AutoMapResult,
} from './validators/jira-cloud.validator.js';
