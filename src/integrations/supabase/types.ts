export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_trade_signals: {
        Row: {
          action: string
          created_at: string
          id: string
          market_data_id: string | null
          raw_response: string
          reason: string
          strike: string
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          market_data_id?: string | null
          raw_response: string
          reason: string
          strike: string
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          market_data_id?: string | null
          raw_response?: string
          reason?: string
          strike?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_trade_signals_market_data_id_fkey"
            columns: ["market_data_id"]
            isOneToOne: false
            referencedRelation: "nifty_market_data"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_trading_sessions: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          last_error: string | null
          last_run_at: string | null
          risk_mode: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          last_error?: string | null
          last_run_at?: string | null
          risk_mode?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          last_error?: string | null
          last_run_at?: string | null
          risk_mode?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      nifty_market_data: {
        Row: {
          close_price: number | null
          created_at: string
          high_price: number | null
          id: string
          low_price: number | null
          ltp: number | null
          open_price: number | null
          raw_payload: Json
          source_timestamp: string | null
          symbol: string
          user_id: string
        }
        Insert: {
          close_price?: number | null
          created_at?: string
          high_price?: number | null
          id?: string
          low_price?: number | null
          ltp?: number | null
          open_price?: number | null
          raw_payload?: Json
          source_timestamp?: string | null
          symbol?: string
          user_id: string
        }
        Update: {
          close_price?: number | null
          created_at?: string
          high_price?: number | null
          id?: string
          low_price?: number | null
          ltp?: number | null
          open_price?: number | null
          raw_payload?: Json
          source_timestamp?: string | null
          symbol?: string
          user_id?: string
        }
        Relationships: []
      }
      trading_api_settings: {
        Row: {
          created_at: string
          id: string
          openai_api_key: string
          redirect_uri: string | null
          token_expires_at: string | null
          updated_at: string
          upstox_access_token: string | null
          upstox_api_key: string
          upstox_api_secret: string
          upstox_refresh_token: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          openai_api_key: string
          redirect_uri?: string | null
          token_expires_at?: string | null
          updated_at?: string
          upstox_access_token?: string | null
          upstox_api_key: string
          upstox_api_secret: string
          upstox_refresh_token?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          openai_api_key?: string
          redirect_uri?: string | null
          token_expires_at?: string | null
          updated_at?: string
          upstox_access_token?: string | null
          upstox_api_key?: string
          upstox_api_secret?: string
          upstox_refresh_token?: string | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
