import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { swaggerSpec } from './swagger.config';

type HttpMethod = 'get' | 'post' | 'put' | 'patch';

const EXPECTED_OPERATIONS: Record<string, HttpMethod[]> = {
  '/api/health': ['get'],
  '/api/auth/bootstrap': ['post'],
  '/api/auth/login': ['post'],
  '/api/auth/me': ['get'],
  '/api/auth/me/password': ['put'],
  '/api/auth/users': ['get', 'post'],
  '/api/auth/users/{userId}': ['get', 'patch'],
  '/api/auth/users/{userId}/password': ['put'],
  '/api/auth/users/{userId}/status': ['patch'],
  '/api/customers': ['get'],
  '/api/orders': ['get'],
  '/api/orders/attention': ['get'],
  '/api/orders/bulk/confirm': ['post'],
  '/api/orders/bulk/remind': ['post'],
  '/api/orders/{id}': ['get'],
  '/api/orders/{id}/confirm': ['post'],
  '/api/orders/{id}/cancel': ['post'],
  '/api/orders/{id}/remind': ['post'],
  '/api/messages': ['get'],
  '/api/messages/{id}': ['get'],
  '/api/messages/{id}/retry': ['post'],
  '/api/dashboard/stats': ['get'],
  '/api/webhooks/shopify/orders-create': ['post'],
  '/api/webhooks/whatsapp': ['get', 'post'],
  '/api/whatsapp/templates': ['get'],
  '/api/whatsapp/message-config': ['get', 'put'],
  '/api/session': ['post']
};

const PROTECTED_OPERATIONS: Array<[string, HttpMethod]> = [
  ['/api/auth/me', 'get'],
  ['/api/auth/me/password', 'put'],
  ['/api/auth/users', 'get'],
  ['/api/auth/users', 'post'],
  ['/api/auth/users/{userId}', 'get'],
  ['/api/auth/users/{userId}', 'patch'],
  ['/api/auth/users/{userId}/password', 'put'],
  ['/api/auth/users/{userId}/status', 'patch'],
  ['/api/customers', 'get'],
  ['/api/orders', 'get'],
  ['/api/orders/attention', 'get'],
  ['/api/orders/bulk/confirm', 'post'],
  ['/api/orders/bulk/remind', 'post'],
  ['/api/orders/{id}', 'get'],
  ['/api/orders/{id}/confirm', 'post'],
  ['/api/orders/{id}/cancel', 'post'],
  ['/api/orders/{id}/remind', 'post'],
  ['/api/messages', 'get'],
  ['/api/messages/{id}', 'get'],
  ['/api/messages/{id}/retry', 'post'],
  ['/api/dashboard/stats', 'get'],
  ['/api/whatsapp/templates', 'get'],
  ['/api/whatsapp/message-config', 'get'],
  ['/api/whatsapp/message-config', 'put']
];

const document = swaggerSpec as Record<string, any>;
const paths = document.paths as Record<string, Record<string, { security?: unknown[]; responses?: object }>>;

describe('Swagger MVP specification', () => {
  it('is a valid OpenAPI document', async () => {
    await expect(SwaggerParser.validate(swaggerSpec as never)).resolves.toBeDefined();
  });

  it('documents every mounted API operation', () => {
    for (const [path, methods] of Object.entries(EXPECTED_OPERATIONS)) {
      expect(paths[path]).toBeDefined();

      for (const method of methods) {
        expect(paths[path][method]).toBeDefined();
      }
    }

    const operationCount = Object.values(EXPECTED_OPERATIONS).reduce((total, methods) => total + methods.length, 0);
    const documentedCount = Object.values(paths).reduce(
      (total, path) => total + Object.keys(path).filter(key => ['get', 'post', 'put', 'patch', 'delete'].includes(key)).length,
      0
    );

    expect(documentedCount).toBe(operationCount);
  });

  it('applies Bearer JWT to every protected helpdesk operation', () => {
    for (const [path, method] of PROTECTED_OPERATIONS) {
      expect(paths[path][method].security).toEqual([{ bearerAuth: [] }]);
    }

    expect(paths['/api/whatsapp/message-config'].put.responses).toHaveProperty('403');
    expect(paths['/api/auth/users'].post.responses).toHaveProperty('403');
    expect(paths['/api/auth/bootstrap'].post.security).toBeUndefined();
  });

  it('includes step 16 delivery fields and no starter metadata', () => {
    const orderProperties = document.components.schemas.Order.properties;

    expect(orderProperties).toHaveProperty('deliveryRegion');
    expect(orderProperties).toHaveProperty('deliveryRegionCode');
    expect(orderProperties).toHaveProperty('deliveryPreferredMoment');
    expect(orderProperties).toHaveProperty('deliveryLatitude');
    expect(document.info.title).not.toMatch(/starter/i);
    expect(document.info.description).not.toMatch(/starter/i);
  });

  it('keeps OpenAPI comments in compiled route documentation', () => {
    const projectRoot = path.resolve(__dirname, '../..');
    const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
    const loadedConfig = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(loadedConfig.config, ts.sys, projectRoot);
    const source = fs.readFileSync(path.join(__dirname, 'routes/health.docs.ts'), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: parsedConfig.options }).outputText;

    expect(parsedConfig.options.removeComments).toBe(false);
    expect(output).toContain('@openapi');
  });

  it('documents strict message variants and template limit errors', () => {
    expect(document.components.schemas.RegionVariant.additionalProperties).toBe(false);
    expect(paths['/api/whatsapp/templates'].get.responses).toHaveProperty('400');
  });

  it('documents the real attention queue and bounded bulk inputs', () => {
    expect(document.components.schemas.AttentionOrder.properties.reason.enum).toEqual([
      'free_text',
      'sms_only',
      'invalid_number',
      'late_confirm',
      'phone_mismatch'
    ]);
    expect(document.components.schemas.AttentionCounts.required).toContain('phone_mismatch');
    expect(document.components.schemas.BulkOrderInput.properties.orderIds.maxItems).toBe(100);
    expect(paths['/api/orders/bulk/confirm'].post.responses).toHaveProperty('207');
  });

  it('documents remaining helpdesk API contracts', () => {
    const orderParameters = (paths['/api/orders'].get as any).parameters as Array<{ name: string }>;
    const messageParameters = (paths['/api/messages'].get as any).parameters as Array<{ name: string }>;

    expect(orderParameters.some(parameter => parameter.name === 'cod')).toBe(true);
    expect(messageParameters.some(parameter => parameter.name === 'orderName')).toBe(true);
    expect(document.components.schemas.Message.properties).toHaveProperty('orderName');
    expect(document.components.schemas.Message.properties).toHaveProperty('fallbackOf');
    expect(document.components.schemas.DashboardStats.properties).toHaveProperty('jobsSucceeded');
    expect(paths['/api/dashboard/stats'].get.security).toEqual([{ bearerAuth: [] }]);
  });
});
