import customtkinter as ctk

# Configure Appearance
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue") # We will override this with manual colors

class CryptoDashboard(ctk.CTk):
    def __init__(self):
        super().__init__()

        # Window Setup
        self.title("ATS Crypto Monitor - Limit Orders")
        self.geometry("1100x700")
        self.configure(fg_color="#050505")

        # Fonts
        self.mono_font = ("Consolas", 13)
        self.mono_font_bold = ("Consolas", 13, "bold")
        self.mono_font_large = ("Consolas", 24, "bold")
        self.mono_font_small = ("Consolas", 11)

        # Main Layout
        self.grid_columnconfigure(0, weight=4)
        self.grid_columnconfigure(1, weight=6)
        self.grid_rowconfigure(1, weight=1)

        self.create_header()
        self.create_left_panel()
        self.create_right_panel()

    def create_header(self):
        header_frame = ctk.CTkFrame(self, fg_color="transparent", height=60)
        header_frame.grid(row=0, column=0, columnspan=2, sticky="ew", padx=30, pady=(20, 10))
        header_frame.grid_propagate(False)

        # Title
        title_label = ctk.CTkLabel(header_frame, text="Limit Orders", font=self.mono_font_large, text_color="white")
        title_label.pack(side="left")

        # Navbar
        nav_frame = ctk.CTkFrame(header_frame, fg_color="#111111", corner_radius=8)
        nav_frame.pack(side="right", fill="y")

        eth_price = ctk.CTkLabel(nav_frame, text="124,240.12 DARK = 14.2 ETH", font=self.mono_font, text_color="#7a8499")
        eth_price.pack(side="left", padx=20)

        bridge_btn = ctk.CTkButton(nav_frame, text="Bridge", width=80, fg_color="transparent", text_color="#7a8499", hover_color="#1a1f2e", font=self.mono_font_bold)
        bridge_btn.pack(side="left", padx=5, pady=5)

        orders_btn = ctk.CTkButton(nav_frame, text="Orders", width=80, fg_color="#F4D03F", text_color="black", hover_color="#d4b435", font=self.mono_font_bold)
        orders_btn.pack(side="left", padx=5, pady=5)

        staking_btn = ctk.CTkButton(nav_frame, text="Staking", width=80, fg_color="transparent", text_color="#7a8499", hover_color="#1a1f2e", font=self.mono_font_bold)
        staking_btn.pack(side="left", padx=(5, 10), pady=5)

    def create_left_panel(self):
        left_panel = ctk.CTkFrame(self, fg_color="#111111", corner_radius=15)
        left_panel.grid(row=1, column=0, sticky="nsew", padx=(30, 15), pady=(10, 30))

        # Token Selection
        ctk.CTkLabel(left_panel, text="Select Token:", font=self.mono_font_bold, text_color="white").pack(anchor="w", padx=25, pady=(30, 5))
        token_dropdown = ctk.CTkOptionMenu(left_panel, values=["$ORDI", "$BTC", "$ETH"], fg_color="#050505", button_color="#1a1f2e", font=self.mono_font, dropdown_font=self.mono_font)
        token_dropdown.pack(fill="x", padx=25, pady=(0, 20))

        # Buy Price
        buy_label_frame = ctk.CTkFrame(left_panel, fg_color="transparent")
        buy_label_frame.pack(fill="x", padx=25)
        ctk.CTkLabel(buy_label_frame, text="Price to Buy at:", font=self.mono_font_bold, text_color="white").pack(side="left")
        ctk.CTkLabel(buy_label_frame, text="+5% +10% +25%", font=self.mono_font_small, text_color="#7a8499").pack(side="right")
        
        buy_entry = ctk.CTkEntry(left_panel, placeholder_text="$73.34", fg_color="#050505", border_color="#1a1f2e", height=40, font=self.mono_font)
        buy_entry.pack(fill="x", padx=25, pady=(5, 20))

        # Sell Price
        sell_label_frame = ctk.CTkFrame(left_panel, fg_color="transparent")
        sell_label_frame.pack(fill="x", padx=25)
        ctk.CTkLabel(sell_label_frame, text="Price to Sell at:", font=self.mono_font_bold, text_color="white").pack(side="left")
        ctk.CTkLabel(sell_label_frame, text="+5% +10% +25%", font=self.mono_font_small, text_color="#7a8499").pack(side="right")
        
        sell_entry = ctk.CTkEntry(left_panel, placeholder_text="$80.52", fg_color="#050505", border_color="#1a1f2e", height=40, font=self.mono_font)
        sell_entry.pack(fill="x", padx=25, pady=(5, 20))

        # Wallet Section
        ctk.CTkLabel(left_panel, text="Wallet:", font=self.mono_font_bold, text_color="white").pack(anchor="w", padx=25, pady=(10, 5))
        
        # Selected Wallet
        selected_wallet_box = ctk.CTkFrame(left_panel, fg_color="#050505", border_width=1, border_color="#F4D03F", height=40)
        selected_wallet_box.pack(fill="x", padx=25, pady=(0, 10))
        ctk.CTkLabel(selected_wallet_box, text="0x3EbcAe57ED8...", font=self.mono_font, text_color="white").pack(side="left", padx=15)

        # Connected Wallets
        wallets = ["0x1A2bC3D4E5F6...", "0x9F8e7D6C5B4A..."]
        for addr in wallets:
            w_frame = ctk.CTkFrame(left_panel, fg_color="transparent")
            w_frame.pack(fill="x", padx=25, pady=2)
            ctk.CTkLabel(w_frame, text=addr, font=self.mono_font_small, text_color="#7a8499").pack(side="left")
            ctk.CTkButton(w_frame, text="🗑", width=20, height=20, fg_color="transparent", text_color="#7a8499", hover_color="#1a1f2e").pack(side="right")

        connect_btn = ctk.CTkButton(left_panel, text="+ Connect New Wallet", fg_color="transparent", text_color="#F4D03F", font=self.mono_font_small, hover_color="#1a1f2e")
        connect_btn.pack(anchor="w", padx=25, pady=(10, 20))

        # Place Order Button
        place_order_btn = ctk.CTkButton(left_panel, text="Place Order", fg_color="#F4D03F", text_color="black", font=self.mono_font_bold, height=50, hover_color="#d4b435")
        place_order_btn.pack(side="bottom", fill="x", padx=25, pady=25)

    def create_right_panel(self):
        right_panel = ctk.CTkFrame(self, fg_color="transparent")
        right_panel.grid(row=1, column=1, sticky="nsew", padx=(15, 30), pady=(10, 30))

        ctk.CTkLabel(right_panel, text="Pending/Active Orders:", font=self.mono_font_bold, text_color="white").pack(anchor="w", pady=(0, 15))

        # Scrollable area
        scroll_frame = ctk.CTkScrollableFrame(right_panel, fg_color="transparent", label_text="")
        scroll_frame.pack(fill="both", expand=True)

        # Dummy data for cards
        for i in range(1, 4):
            self.create_order_card(scroll_frame, f"Order #{i}")

    def create_order_card(self, parent, order_num):
        card = ctk.CTkFrame(parent, fg_color="#111111", border_width=1, border_color="#1a1f2e", corner_radius=10)
        card.pack(fill="x", pady=10)

        # Row 1
        row1 = ctk.CTkFrame(card, fg_color="transparent")
        row1.pack(fill="x", padx=15, pady=(10, 5))
        ctk.CTkLabel(row1, text=order_num, font=self.mono_font, text_color="#7a8499").pack(side="left")
        ctk.CTkLabel(row1, text="Token: [$ORDI]", font=self.mono_font, text_color="#7a8499").pack(side="right")

        # Row 2
        row2 = ctk.CTkFrame(card, fg_color="transparent")
        row2.pack(fill="x", padx=15, pady=5)
        ctk.CTkLabel(row2, text="BUY: $73.34", font=self.mono_font_bold, text_color="#2ECC71").pack(side="left")
        ctk.CTkLabel(row2, text="SELL: $80.52", font=self.mono_font_bold, text_color="#E74C3C", padx=20).pack(side="left")
        ctk.CTkLabel(row2, text="Price: $73.89", font=self.mono_font, text_color="white").pack(side="right")

        # Row 3
        row3 = ctk.CTkFrame(card, fg_color="transparent")
        row3.pack(fill="x", padx=15, pady=(5, 10))
        ctk.CTkLabel(row3, text="0xFFx2320...qerrte", font=self.mono_font_small, text_color="#7a8499").pack(side="left")
        
        btn_frame = ctk.CTkFrame(row3, fg_color="transparent")
        btn_frame.pack(side="right")
        
        ctk.CTkButton(btn_frame, text="Order Settings", width=100, height=24, fg_color="#1a1f2e", text_color="white", font=self.mono_font_small).pack(side="left", padx=5)
        ctk.CTkButton(btn_frame, text="Delete Order", width=100, height=24, fg_color="transparent", text_color="#7a8499", font=self.mono_font_small, border_width=1, border_color="#1a1f2e").pack(side="left")

if __name__ == "__main__":
    app = CryptoDashboard()
    app.mainloop()
