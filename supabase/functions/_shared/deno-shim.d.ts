declare const Deno: {
  env: {
    get(name: string): string | undefined;
  };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

declare module "npm:@supabase/supabase-js@2" {
  export function createClient(url: string, key: string): any;
}

declare module "npm:bcryptjs@2.4.3" {
  const bcrypt: {
    compare(data: string, encrypted: string): Promise<boolean>;
    compareSync(data: string, encrypted: string): boolean;
    hash(data: string, salt: number): Promise<string>;
    hashSync(data: string, salt: number): string;
  };
  export default bcrypt;
}

declare module "https://deno.land/x/djwt@v3.0.2/mod.ts" {
  export function create(
    header: Record<string, unknown>,
    payload: Record<string, unknown>,
    key: CryptoKey,
  ): Promise<string>;

  export function verify(token: string, key: CryptoKey): Promise<Record<string, unknown>>;

  export function getNumericDate(exp: number): number;
}
