export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18";
  };
  public: {
    Tables: {
      attendance_logs: {
        Row: {
          break_minutes: number;
          clock_in: string;
          clock_out: string | null;
          id: string;
          is_late: boolean;
          notes: string | null;
          overtime_min: number;
          total_hours: number | null;
          user_id: string;
          verification_method: string;
          override_by: string | null;
        };
        Insert: {
          break_minutes?: number;
          clock_in?: string;
          clock_out?: string | null;
          id?: string;
          is_late?: boolean;
          notes?: string | null;
          overtime_min?: number;
          total_hours?: number | null;
          user_id: string;
          verification_method?: string;
          override_by?: string | null;
        };
        Update: {
          break_minutes?: number;
          clock_in?: string;
          clock_out?: string | null;
          id?: string;
          is_late?: boolean;
          notes?: string | null;
          overtime_min?: number;
          total_hours?: number | null;
          user_id?: string;
          verification_method?: string;
          override_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "attendance_logs_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "staff_profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      categories: {
        Row: {
          id: string;
          name: string;
          sort_order: number;
        };
        Insert: {
          id?: string;
          name: string;
          sort_order?: number;
        };
        Update: {
          id?: string;
          name?: string;
          sort_order?: number;
        };
        Relationships: [];
      };
      ingredients: {
        Row: {
          cost_per_unit: number;
          current_stock: number;
          expires_at: string | null;
          id: string;
          is_available: boolean;
          low_stock_notified_at: string | null;
          min_threshold: number;
          name: string;
          reorder_level: number;
          unit: string;
        };
        Insert: {
          cost_per_unit?: number;
          current_stock?: number;
          expires_at?: string | null;
          id?: string;
          is_available?: boolean;
          low_stock_notified_at?: string | null;
          min_threshold?: number;
          name: string;
          reorder_level?: number;
          unit: string;
        };
        Update: {
          cost_per_unit?: number;
          current_stock?: number;
          expires_at?: string | null;
          id?: string;
          is_available?: boolean;
          low_stock_notified_at?: string | null;
          min_threshold?: number;
          name?: string;
          reorder_level?: number;
          unit?: string;
        };
        Relationships: [];
      };
      menu_items: {
        Row: {
          base_price: number;
          category_id: string;
          id: string;
          image_url: string | null;
          is_active: boolean;
          is_available: boolean;
          name: string;
          target_station: Database["public"]["Enums"]["station"];
        };
        Insert: {
          base_price: number;
          category_id: string;
          id?: string;
          image_url?: string | null;
          is_active?: boolean;
          is_available?: boolean;
          name: string;
          target_station: Database["public"]["Enums"]["station"];
        };
        Update: {
          base_price?: number;
          category_id?: string;
          id?: string;
          image_url?: string | null;
          is_active?: boolean;
          is_available?: boolean;
          name?: string;
          target_station?: Database["public"]["Enums"]["station"];
        };
        Relationships: [
          {
            foreignKeyName: "menu_items_category_id_fkey";
            columns: ["category_id"];
            isOneToOne: false;
            referencedRelation: "categories";
            referencedColumns: ["id"];
          },
        ];
      };
      order_items: {
        Row: {
          id: string;
          item_price: number;
          item_status: Database["public"]["Enums"]["order_status"];
          menu_item_id: string;
          modifiers: Json | null;
          name: string;
          order_id: string;
          quantity: number;
          station: Database["public"]["Enums"]["station"];
        };
        Insert: {
          id?: string;
          item_price: number;
          item_status?: Database["public"]["Enums"]["order_status"];
          menu_item_id: string;
          modifiers?: Json | null;
          name: string;
          order_id: string;
          quantity: number;
          station: Database["public"]["Enums"]["station"];
        };
        Update: {
          id?: string;
          item_price?: number;
          item_status?: Database["public"]["Enums"]["order_status"];
          menu_item_id?: string;
          modifiers?: Json | null;
          name?: string;
          order_id?: string;
          quantity?: number;
          station?: Database["public"]["Enums"]["station"];
        };
        Relationships: [
          {
            foreignKeyName: "order_items_menu_item_id_fkey";
            columns: ["menu_item_id"];
            isOneToOne: false;
            referencedRelation: "menu_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "order_items_order_id_fkey";
            columns: ["order_id"];
            isOneToOne: false;
            referencedRelation: "orders";
            referencedColumns: ["id"];
          },
        ];
      };
      orders: {
        Row: {
          cashier_id: string;
          client_id: string;
          created_at: string;
          created_offline: boolean;
          customer_name: string | null;
          table_number: string | null;
          cash_received: number;
          discount_amount: number;
          discount_type: string | null;
          gcash_amount: number;
          gcash_reference: string | null;
          id: string;
          order_number: number;
          order_type: Database["public"]["Enums"]["order_type"];
          payment_reference: string | null;
          payment_method: string;
          settled_at: string | null;
          status: Database["public"]["Enums"]["order_status"];
          total_amount: number;
        };
        Insert: {
          cashier_id: string;
          client_id: string;
          created_at?: string;
          created_offline?: boolean;
          customer_name?: string | null;
          table_number?: string | null;
          cash_received?: number;
          discount_amount?: number;
          discount_type?: string | null;
          gcash_amount?: number;
          gcash_reference?: string | null;
          id?: string;
          order_number?: number;
          order_type: Database["public"]["Enums"]["order_type"];
          payment_reference?: string | null;
          payment_method?: string;
          settled_at?: string | null;
          status?: Database["public"]["Enums"]["order_status"];
          total_amount: number;
        };
        Update: {
          cashier_id?: string;
          client_id?: string;
          created_at?: string;
          created_offline?: boolean;
          customer_name?: string | null;
          table_number?: string | null;
          cash_received?: number;
          discount_amount?: number;
          discount_type?: string | null;
          gcash_amount?: number;
          gcash_reference?: string | null;
          id?: string;
          order_number?: number;
          order_type?: Database["public"]["Enums"]["order_type"];
          payment_reference?: string | null;
          payment_method?: string;
          settled_at?: string | null;
          status?: Database["public"]["Enums"]["order_status"];
          total_amount?: number;
        };
        Relationships: [
          {
            foreignKeyName: "orders_cashier_id_fkey";
            columns: ["cashier_id"];
            isOneToOne: false;
            referencedRelation: "staff_profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      order_audit_logs: {
        Row: {
          action: string;
          after_state: Json;
          before_state: Json;
          created_at: string;
          employee_id: string;
          id: string;
          order_id: string;
          reason: string | null;
        };
        Insert: {
          action: string;
          after_state?: Json;
          before_state?: Json;
          created_at?: string;
          employee_id: string;
          id?: string;
          order_id: string;
          reason?: string | null;
        };
        Update: {
          action?: string;
          after_state?: Json;
          before_state?: Json;
          created_at?: string;
          employee_id?: string;
          id?: string;
          order_id?: string;
          reason?: string | null;
        };
        Relationships: [];
      };
      recipe_ingredients: {
        Row: {
          id: string;
          ingredient_id: string;
          menu_item_id: string;
          quantity_req: number;
        };
        Insert: {
          id?: string;
          ingredient_id: string;
          menu_item_id: string;
          quantity_req: number;
        };
        Update: {
          id?: string;
          ingredient_id?: string;
          menu_item_id?: string;
          quantity_req?: number;
        };
        Relationships: [
          {
            foreignKeyName: "recipe_ingredients_ingredient_id_fkey";
            columns: ["ingredient_id"];
            isOneToOne: false;
            referencedRelation: "ingredients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recipe_ingredients_menu_item_id_fkey";
            columns: ["menu_item_id"];
            isOneToOne: false;
            referencedRelation: "menu_items";
            referencedColumns: ["id"];
          },
        ];
      };
      staff_profiles: {
        Row: {
          created_at: string;
          full_name: string;
          hourly_rate: number;
          id: string;
          is_active: boolean;
          staff_code: string;
        };
        Insert: {
          created_at?: string;
          full_name: string;
          hourly_rate?: number;
          id: string;
          is_active?: boolean;
          staff_code: string;
        };
        Update: {
          created_at?: string;
          full_name?: string;
          hourly_rate?: number;
          id?: string;
          is_active?: boolean;
          staff_code?: string;
        };
        Relationships: [];
      };
      staff_face_descriptors: {
        Row: {
          descriptor: Json;
          enrolled_at: string;
          user_id: string;
        };
        Insert: {
          descriptor: Json;
          enrolled_at?: string;
          user_id: string;
        };
        Update: {
          descriptor?: Json;
          enrolled_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "staff_face_descriptors_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "staff_profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_logs: {
        Row: {
          action_type: string;
          actor_role: string;
          actor_user_id: string | null;
          created_at: string;
          entity_id: string | null;
          entity_label: string | null;
          entity_type: string;
          id: string;
          new_value: Json | null;
          old_value: Json | null;
        };
        Insert: {
          action_type: string;
          actor_role?: string;
          actor_user_id?: string | null;
          created_at?: string;
          entity_id?: string | null;
          entity_label?: string | null;
          entity_type: string;
          id?: string;
          new_value?: Json | null;
          old_value?: Json | null;
        };
        Update: {
          action_type?: string;
          actor_role?: string;
          actor_user_id?: string | null;
          created_at?: string;
          entity_id?: string | null;
          entity_label?: string | null;
          entity_type?: string;
          id?: string;
          new_value?: Json | null;
          old_value?: Json | null;
        };
        Relationships: [];
      };
      stock_transactions: {
        Row: {
          change: number;
          created_at: string;
          id: string;
          ingredient_id: string;
          order_id: string | null;
          reason: string;
          user_id: string | null;
        };
        Insert: {
          change: number;
          created_at?: string;
          id?: string;
          ingredient_id: string;
          order_id?: string | null;
          reason: string;
          user_id?: string | null;
        };
        Update: {
          change?: number;
          created_at?: string;
          id?: string;
          ingredient_id?: string;
          order_id?: string | null;
          reason?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "stock_transactions_ingredient_id_fkey";
            columns: ["ingredient_id"];
            isOneToOne: false;
            referencedRelation: "ingredients";
            referencedColumns: ["id"];
          },
        ];
      };
      user_roles: {
        Row: {
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_roles_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "staff_profiles";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      restore_business_backup: {
        Args: { _actor_user_id: string; _backup: Json };
        Returns: undefined;
      };
      place_order_with_table: {
        Args: { payload: Json };
        Returns: Json;
      };
      update_open_order: {
        Args: {
          _discount_type: string;
          _customer_name: string | null;
          _items: Json;
          _order_id: string;
          _order_type: Database["public"]["Enums"]["order_type"];
          _table_number: string | null;
        };
        Returns: undefined;
      };
      adjust_stock: {
        Args: { _change: number; _ingredient_id: string; _reason: string };
        Returns: undefined;
      };
      get_income_analytics: {
        Args: { _end: string; _start: string };
        Returns: {
          day: string;
          order_count: number;
          revenue: number;
        }[];
      };
      clock_in: {
        Args: { _late?: boolean };
        Returns: {
          break_minutes: number;
          clock_in: string;
          clock_out: string | null;
          id: string;
          is_late: boolean;
          notes: string | null;
          overtime_min: number;
          total_hours: number | null;
          user_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "attendance_logs";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      clock_out: {
        Args: { _break_minutes?: number };
        Returns: {
          break_minutes: number;
          clock_in: string;
          clock_out: string | null;
          id: string;
          is_late: boolean;
          notes: string | null;
          overtime_min: number;
          total_hours: number | null;
          user_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "attendance_logs";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      record_verified_attendance: {
        Args: {
          _action: string;
          _break_minutes: number;
          _override_by?: string | null;
          _user_id: string;
          _verification_method: string;
        };
        Returns: {
          break_minutes: number;
          clock_in: string;
          clock_out: string | null;
          id: string;
          is_late: boolean;
          notes: string | null;
          overtime_min: number;
          total_hours: number | null;
          user_id: string;
          verification_method: string;
          override_by: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "attendance_logs";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      has_any_role: {
        Args: {
          _roles: Database["public"]["Enums"]["app_role"][];
          _user_id: string;
        };
        Returns: boolean;
      };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      is_manager: { Args: { _user_id: string }; Returns: boolean };
      is_staff: { Args: { _user_id: string }; Returns: boolean };
      complete_order: { Args: { _order_id: string }; Returns: undefined };
      mark_order_items_ready: {
        Args: {
          _item_ids: string[];
          _station: Database["public"]["Enums"]["station"];
        };
        Returns: undefined;
      };
      modify_order: {
        Args: { _items: Json; _order_id: string };
        Returns: undefined;
      };
      settle_order: {
        Args: {
          _cash_received?: number;
          _gcash_amount?: number;
          _gcash_reference?: string | null;
          _order_id: string;
          _payment_method: string;
        };
        Returns: undefined;
      };
      void_order: {
        Args: { _order_id: string; _reason: string };
        Returns: undefined;
      };
      list_login_staff: {
        Args: never;
        Returns: {
          full_name: string;
          id: string;
          staff_code: string;
        }[];
      };
      place_order: { Args: { payload: Json }; Returns: Json };
    };
    Enums: {
      app_role: "OWNER" | "ADMIN" | "MANAGER" | "CASHIER" | "BARISTA" | "KITCHEN";
      order_status: "PENDING" | "IN_PREP" | "READY" | "COMPLETED" | "CANCELLED";
      order_type: "DINE_IN" | "TAKEOUT" | "ADVANCE";
      station: "BARISTA" | "KITCHEN";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      app_role: ["ADMIN", "MANAGER", "CASHIER", "BARISTA", "KITCHEN"],
      order_status: ["PENDING", "IN_PREP", "READY", "COMPLETED", "CANCELLED"],
      order_type: ["DINE_IN", "TAKEOUT", "ADVANCE"],
      station: ["BARISTA", "KITCHEN"],
    },
  },
} as const;
