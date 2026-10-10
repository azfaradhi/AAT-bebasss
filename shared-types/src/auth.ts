export type ClientScope = 'media' | 'lapangan' | 'internal';

export interface ClientAccessTokenClaims {
  sub: string;            // client_id
  scope: ClientScope;
  aud: 'bnpb-client';
  purpose: 'access';
  iat: number;
  exp: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}

export interface ClientRefreshTokenClaims {
  sub: string;
  scope: ClientScope;
  aud: 'bnpb-client';
  purpose: 'refresh';
  iat: number;
  exp: number;
}
